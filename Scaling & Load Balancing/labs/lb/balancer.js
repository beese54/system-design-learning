// The load balancer you can read.
//
// It is an L7 proxy: it terminates the client's connection, decides which
// backend should serve the request, opens (or reuses) a connection to that
// backend, and copies the response back. Roughly 200 lines, and every decision
// nginx makes has a visible counterpart here - which is what Tab 8 lines up.
//
// Runnable alone:
//   node lb/balancer.js --port=4310 --backends=4311,4312,4313
import http from 'node:http';
import { basename } from 'node:path';
import { POLICIES, buildRing, resetCursor } from './policies.js';
import { createChecker } from './health.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function createBalancer({
  port = 4310,
  policy = 'round-robin',
  health = {},
  retryOnFailure = true
} = {}) {
  let retry = retryOnFailure;
  const backends = new Map();   // id -> { id, port, inflight, served, failed, ewmaMs }
  const checker = createChecker(health);
  let ring = [];
  let current = policy;

  // Per-backend keep-alive, with a FINITE socket cap.
  //
  // Leaving maxSockets at Infinity makes least-connections meaningless: there is
  // never a queue, because a new socket is always available. A real balancer has
  // a bounded pool per upstream, and the bound is what turns "in flight" into a
  // number worth choosing on.
  const agents = new Map();
  const agentFor = (id) => {
    if (!agents.has(id)) {
      agents.set(id, new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 }));
    }
    return agents.get(id);
  };

  const stats = {
    requests: 0, ok: 0, failed: 0, retried: 0, noBackend: 0,
    startedAt: Date.now()
  };

  function setBackends(list) {
    backends.clear();
    for (const b of list) {
      backends.set(b.id, { id: b.id, port: b.port, inflight: 0, served: 0, failed: 0, ewmaMs: 0 });
      checker.add(b.id, b.port);
    }
    for (const id of [...checker.snapshot().nodes.map((n) => n.id)]) {
      if (!backends.has(id)) checker.remove(id);
    }
    ring = buildRing([...backends.keys()]);
    resetCursor();
  }

  // Retry is a lab control rather than a fixed default, because whether it is on
  // changes what a user experiences during an outage more than almost anything
  // else. With it on, one dead instance out of four is invisible. With it off,
  // a quarter of requests fail until the checker ejects it. The Failure tab runs
  // both so the difference is the lesson rather than a footnote.
  function setRetry(on) { retry = !!on; return { ok: true, retry }; }

  function setPolicy(name) {
    if (!POLICIES[name]) return { ok: false, error: 'Unknown policy: ' + name };
    current = name;
    resetCursor();
    return { ok: true, policy: name };
  }

  // Eligible backends, filtered by the health checker and biased by slow-start
  // weight. A backend at weight 0.2 is skipped four times in five, which is how
  // a ramp is implemented without a scheduler.
  function eligible() {
    const healthy = checker.eligible();
    const pool = [];
    for (const n of healthy) {
      const b = backends.get(n.id);
      if (!b) continue;
      const w = checker.weight(n);
      if (w >= 1 || Math.random() < w) pool.push(b);
    }
    // If ramping filtered everything out this instant, fall back to the full
    // healthy set rather than answering 503 for a timing accident.
    if (!pool.length && healthy.length) {
      return healthy.map((n) => backends.get(n.id)).filter(Boolean);
    }
    return pool;
  }

  function choose(key) {
    const pool = eligible();
    if (!pool.length) return null;
    const p = POLICIES[current];
    return p.pick(pool, key, ring);
  }

  function proxy(backend, req, res, body, attempt, startedAt) {
    return new Promise((resolve) => {
      backend.inflight++;
      const t0 = performance.now();

      const upstream = http.request({
        host: '127.0.0.1',
        port: backend.port,
        path: req.url,
        method: req.method,
        agent: agentFor(backend.id),
        headers: { ...req.headers, host: '127.0.0.1:' + backend.port }
      }, (up) => {
        const ms = performance.now() - t0;
        backend.inflight--;
        backend.ewmaMs = backend.ewmaMs ? backend.ewmaMs * 0.8 + ms * 0.2 : ms;

        const failed = up.statusCode >= 500;
        if (failed) backend.failed++; else backend.served++;
        checker.observe(backend.id, !failed);

        // Retry once, on another backend, for a 5xx. This is
        // proxy_next_upstream, and it is the difference between one broken
        // instance being invisible to users and being visible to a quarter of
        // them. It is only safe because /work is idempotent - retrying a POST
        // that already charged a card is a different lesson entirely.
        if (failed && retry && attempt === 0) {
          up.resume();
          const alt = eligible().filter((b) => b.id !== backend.id);
          if (alt.length) {
            stats.retried++;
            const next = POLICIES[current].pick(alt, null, ring);
            return resolve(proxy(next, req, res, body, 1, startedAt));
          }
        }

        res.writeHead(up.statusCode, {
          ...up.headers,
          'X-Lab-Balancer': current,
          'X-Lab-Chose': backend.id,
          'X-Lab-Attempt': String(attempt + 1),
          'X-Lab-Upstream-Ms': String(round2(ms)),
          'X-Lab-Total-Ms': String(round2(performance.now() - startedAt))
        });
        up.pipe(res);
        up.on('end', () => resolve(failed ? 'failed' : 'ok'));
      });

      upstream.on('error', (err) => {
        backend.inflight--;
        backend.failed++;
        checker.observe(backend.id, false);

        if (retry && attempt === 0) {
          const alt = eligible().filter((b) => b.id !== backend.id);
          if (alt.length) {
            stats.retried++;
            const next = POLICIES[current].pick(alt, null, ring);
            return resolve(proxy(next, req, res, body, 1, startedAt));
          }
        }
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'X-Lab-Chose': backend.id });
          res.end(JSON.stringify({ ok: false, error: 'upstream ' + backend.id + ': ' + (err.code || err.message) }));
        }
        resolve('failed');
      });

      // A hung backend accepts the connection and never answers. Without this
      // the proxy would wait forever and the client with it - one broken
      // instance would consume the balancer's own capacity, which is how a
      // single failure becomes a total outage.
      upstream.setTimeout(5000, () => upstream.destroy(new Error('ETIMEDOUT')));

      if (body) upstream.write(body);
      upstream.end();
    });
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = performance.now();
    stats.requests++;

    if (req.url === '/lb/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(snapshot(), null, 2));
    }

    // Sticky policies need a key. A real balancer takes it from a cookie or the
    // client IP; here the client passes ?key= so the Stateless tab can drive
    // thousands of distinct "users" from one process.
    const key = new URL(req.url, 'http://127.0.0.1').searchParams.get('key');

    const backend = choose(key);
    if (!backend) {
      stats.noBackend++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: false,
        error: 'No healthy backend. Every instance is ejected or the fleet is empty.'
      }));
    }

    const outcome = await proxy(backend, req, res, null, 0, startedAt);
    if (outcome === 'ok') stats.ok++; else stats.failed++;
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  function snapshot() {
    return {
      policy: current,
      retry,
      port,
      stats: { ...stats, uptimeMs: Date.now() - stats.startedAt },
      backends: [...backends.values()].map((b) => ({
        id: b.id, port: b.port, inflight: b.inflight,
        served: b.served, failed: b.failed, ewmaMs: round2(b.ewmaMs)
      })),
      health: checker.snapshot()
    };
  }

  function resetStats() {
    stats.requests = 0; stats.ok = 0; stats.failed = 0; stats.retried = 0; stats.noBackend = 0;
    stats.startedAt = Date.now();
    for (const b of backends.values()) { b.served = 0; b.failed = 0; b.ewmaMs = 0; }
    checker.clearEvents();
  }

  return {
    server,
    setBackends,
    setPolicy,
    setRetry,
    snapshot,
    resetStats,
    checker,
    listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => { checker.stop(); server.close(); for (const a of agents.values()) a.destroy(); },
    startHealth: () => checker.start(),
    get policy() { return current; }
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith('/' + basename(process.argv[1]));

if (invokedDirectly) {
  const arg = (k, d) => {
    const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const lb = createBalancer({ port: Number(arg('port', 4310)), policy: arg('policy', 'round-robin') });
  lb.setBackends(String(arg('backends', '4311')).split(',').map((p, i) => ({ id: 'i' + (i + 1), port: Number(p) })));
  lb.startHealth();
  await lb.listen();
  console.log('  balancer on ' + arg('port', 4310) + ' -> ' + arg('backends', '4311') + ' (' + lb.policy + ')');
}
