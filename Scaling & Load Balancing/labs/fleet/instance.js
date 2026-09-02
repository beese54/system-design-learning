// One app instance. The supervisor forks several of these and the load balancer
// spreads requests across them. This file is the thing being scaled.
//
// Runnable on its own, which is worth doing once:
//   node fleet/instance.js --id=i1 --port=4311 --workers=1
//   curl "http://127.0.0.1:4311/work?mode=io"
//
// It is an ordinary Node service. Nothing here is simulated except the failures,
// and those are injected deliberately so that Lessons 05 and 06 have something
// real to detect and eject.
import http from 'node:http';
import cluster from 'node:cluster';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { q, pool, POOL_SIZE } from '../db/pool.js';
import { STATES } from './faults.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ID = arg('id', 'i1');
const PORT = Number(arg('port', 4311));
const WORKERS = Math.max(1, Number(arg('workers', 1)));

// ---------------------------------------------------------------- work modes
//
// The chapter turns on this distinction, so it is worth being exact about what
// each mode actually costs. All figures measured on the machine this was built
// on; yours will differ, and the lab prints its own.
//
//   cpu        A fixed number of SHA-256 rounds. Burns a core and nothing else.
//              This is the ONLY mode where instance count is causally the
//              independent variable, because it is the only one where the app
//              tier is the bottleneck.
//
//   io:query   A real indexed query. 0.65 ms, of which 0.50 ms is the round
//              trip. Cheap, wait-dominated, and it does NOT saturate Postgres.
//
//   io:scan    A deliberately expensive join aggregate. 17.2 ms of real work
//              inside Postgres. This is the shared dependency that saturates,
//              and it is how you discover you scaled the wrong tier.
//
//   io:sleep   pg_sleep. Zero CPU anywhere - a stand-in for a remote dependency
//              that is pure waiting. Perfectly linear until the connection
//              ceiling, and honest only if you say it is a simulation.
//
//   mixed      Some of each, which is what a real endpoint looks like.
//
// The `downstreamMs` timer stands in for a call to a service you do not own. To
// an event loop, waiting on a payment API and waiting on a timer are the same
// thing: the process has nothing to do either way. The timer just makes the
// wait reproducible in a way a third-party API would never be.

const IO_QUERY = `SELECT count(*)::int AS n
                    FROM plays
                   WHERE track_id = $1 AND played_at > now() - interval '30 days'`;

const IO_SCAN = `SELECT ar.id, count(p.id) AS n
                   FROM artists ar
                   JOIN albums al ON al.artist_id = ar.id
                   JOIN tracks t  ON t.album_id  = al.id
                   JOIN plays p   ON p.track_id  = t.id
                  GROUP BY ar.id
                  ORDER BY n DESC
                  LIMIT 10`;

// Calibrated by the lab host and passed in, so every instance in the fleet does
// byte-identical work. Deliberately NOT calibrated per instance: if each one
// tuned itself to its own core, the slower cores would quietly do less work and
// the heterogeneity this chapter wants to expose would vanish into the
// calibration.
const HASH_ROUNDS = Number(process.env.HASH_ROUNDS || 12000);

function burnCpu(rounds) {
  let buf = Buffer.from(ID);
  for (let i = 0; i < rounds; i++) buf = createHash('sha256').update(buf).digest();
  return buf.toString('hex').slice(0, 8);
}

async function doWork(mode, downstreamMs, rounds) {
  const track = 't' + (1 + Math.floor(Math.random() * 8000));

  if (mode === 'cpu') return { digest: burnCpu(rounds) };

  if (mode === 'io:scan') {
    const { rows } = await q(IO_SCAN);
    return { top: rows.length };
  }

  if (mode === 'io:sleep') {
    await q('SELECT pg_sleep($1)', [downstreamMs / 1000]);
    return { slept: downstreamMs };
  }

  if (mode === 'mixed') {
    const digest = burnCpu(Math.floor(rounds / 4));
    const { rows } = await q(IO_QUERY, [track]);
    if (downstreamMs > 0) await sleep(downstreamMs);
    return { digest, plays: rows[0].n };
  }

  // io:query, the default
  const { rows } = await q(IO_QUERY, [track]);
  if (downstreamMs > 0) await sleep(downstreamMs);
  return { plays: rows[0].n };
}

let state = 'healthy';
let extraLatencyMs = 0;
let warmingUntil = 0;
let flapPeriodMs = 3000;

let inflight = 0;
let served = 0;
let failed = 0;

const startedAt = Date.now();
// Flap on a clock rather than a counter so that the period is in seconds the
// reader can see on a chart, not in requests they cannot.
const flapUnhealthy = () => Math.floor((Date.now() - startedAt) / flapPeriodMs) % 2 === 1;
const isWarming = () => Date.now() < warmingUntil;

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Which instance and which worker actually answered. The balancer tabs read
    // these rather than trusting the balancer's own bookkeeping - if the two
    // ever disagree, the header is the one telling the truth.
    'X-Lab-Instance': ID,
    'X-Lab-Worker': String(process.pid),
    'X-Lab-Inflight': String(inflight),
    ...headers
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // `dead` and `hung` differ in a way that matters enormously to a balancer.
  // dead: the listener is closed, so the connection is REFUSED in microseconds.
  // hung: the connection is accepted and then abandoned, so the balancer learns
  //       nothing until its timeout fires. Same outage, detection times three
  //       orders of magnitude apart.
  if (state === 'hung') return; // socket held open, no response, ever

  // The null endpoint. Used by the load driver to measure its OWN ceiling
  // before it measures anything else - if a run exceeds ~70% of this, the
  // number says more about the driver than the fleet.
  if (path === '/ping') return json(res, 200, { ok: true });

  // --- liveness: is this process running?
  // Deliberately shallow, and that is the correct design. A liveness probe that
  // checks the database will restart a perfectly healthy process because
  // something else broke, which is how a dependency blip becomes a restart storm.
  if (path === '/healthz') {
    if (state === 'flapping' && flapUnhealthy()) {
      return json(res, 503, { ok: false, id: ID, reason: 'injected: flapping' });
    }
    return json(res, 200, { ok: true, id: ID, pid: process.pid, state });
  }

  // --- readiness: should this instance be sent traffic right now?
  if (path === '/readyz') {
    if (isWarming()) return json(res, 503, { ok: false, id: ID, reason: 'warming up' });
    if (state === 'unready') return json(res, 503, { ok: false, id: ID, reason: 'injected: unready' });
    if (state === 'flapping' && flapUnhealthy()) {
      return json(res, 503, { ok: false, id: ID, reason: 'injected: flapping' });
    }
    // `error` and `zombie` deliberately pass readiness. That is the whole point
    // of them: the instance believes it is fine and it is not.
    return json(res, 200, { ok: true, id: ID, inflight, served });
  }

  // --- deep check: readiness that also proves the dependency works.
  // Lesson 06 builds a cascading outage out of this endpoint: point every
  // instance's check at one database, make the database blip, and a balancer
  // that trusts this check ejects the whole fleet for a fault that broke
  // nothing in any instance.
  if (path === '/deepz') {
    if (state === 'deep-fail') {
      return json(res, 503, { ok: false, id: ID, reason: 'injected: dependency unreachable' });
    }
    try {
      await q('SELECT 1 FROM lab_ready');
      return json(res, 200, { ok: true, id: ID, checked: 'database' });
    } catch (err) {
      return json(res, 503, { ok: false, id: ID, reason: 'database unreachable: ' + err.message });
    }
  }

  if (path === '/stats') {
    return json(res, 200, {
      id: ID, pid: process.pid, port: PORT, state, workers: WORKERS,
      inflight, served, failed, poolSize: POOL_SIZE,
      cores: os.cpus().length, rssMb: Math.round(process.memoryUsage().rss / 1048576)
    });
  }

  // Control plane. The supervisor calls this; nothing else should.
  if (path === '/inject' && req.method === 'POST') {
    const next = url.searchParams.get('state') || 'healthy';
    if (!STATES[next]) return json(res, 400, { ok: false, error: 'Unknown state: ' + next });

    state = next;
    extraLatencyMs = Number(url.searchParams.get('latencyMs') || (next === 'slow' ? 300 : 0));
    flapPeriodMs = Number(url.searchParams.get('flapMs') || 3000);

    if (next === 'dead') {
      // Genuinely stop, so connections are refused rather than answered with a
      // polite error. A "dead" instance that still replies is not dead, and the
      // detection times would be a fiction.
      //
      // Both calls are needed, and the second one is easy to miss. `close()`
      // only stops accepting NEW connections - every established keep-alive
      // socket keeps working. The first version of this lab called just
      // `close()`, and the health checker went on getting healthy replies over
      // the connection it had already opened, so a "dead" instance was never
      // ejected. That is a real production failure mode too: a process that has
      // stopped accepting work still looks fine to anything already connected
      // to it.
      json(res, 200, { ok: true, id: ID, state, note: 'listener closed and existing connections dropped' });
      server.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return;
    }
    return json(res, 200, { ok: true, id: ID, state, extraLatencyMs });
  }

  if (path === '/revive' && req.method === 'POST') {
    state = 'healthy';
    extraLatencyMs = 0;
    // Come back not-ready for a moment, the way a real process does. Without
    // this there is nothing for slow-start to ramp and Lesson 06 has no subject.
    warmingUntil = Date.now() + Number(url.searchParams.get('warmMs') || 4000);
    if (!server.listening) server.listen(PORT, '0.0.0.0');
    return json(res, 200, { ok: true, id: ID, state, warmingForMs: warmingUntil - Date.now() });
  }

  // --- the unit of work
  if (path === '/work') {
    if (state === 'zombie') {
      // Fails instantly and cheaply. The damage is not the error - it is that
      // this instance now looks like the fastest and least loaded member of the
      // pool, so a latency- or connection-aware policy sends it MORE traffic.
      failed++;
      return json(res, 500, { ok: false, id: ID, error: 'injected: zombie' });
    }
    if (state === 'error') {
      failed++;
      return json(res, 500, { ok: false, id: ID, error: 'injected: error - note that /healthz still passes' });
    }
    if (state === 'unready' || (state === 'flapping' && flapUnhealthy())) {
      failed++;
      return json(res, 503, { ok: false, id: ID, error: 'injected: not ready' });
    }

    const mode = url.searchParams.get('mode') || 'io:query';
    const downstreamMs = Number(url.searchParams.get('downstreamMs') ?? 5);
    const rounds = Number(url.searchParams.get('rounds') ?? HASH_ROUNDS);

    inflight++;
    const t0 = performance.now();
    try {
      if (extraLatencyMs > 0) await sleep(extraLatencyMs);
      const result = await doWork(mode, downstreamMs, rounds);
      served++;
      return json(res, 200, {
        ok: true, id: ID, pid: process.pid, mode,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        ...result
      });
    } catch (err) {
      failed++;
      return json(res, 500, { ok: false, id: ID, error: String(err.message || err) });
    } finally {
      inflight--;
    }
  }

  return json(res, 404, { ok: false, error: 'No route at ' + path });
});

// Keep-alive matters more than it looks on Windows. The dynamic port range here
// is 16,384 ports wide and TIME_WAIT lasts 120 seconds, which caps sustained
// new connections at roughly 136 per second before the machine runs out of
// ephemeral ports and starts refusing - about two minutes into a run, looking
// exactly like a server failure. Reusing connections avoids the whole problem.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// ---------------------------------------------------------------- clustering
//
// Vertical scaling, in about ten lines: the primary forks N workers, they share
// one listening socket, and the OS hands accepted connections to whichever one
// it likes. Same box, same port, more cores in play.
//
// On Windows `cluster.schedulingPolicy` is SCHED_NONE - workers race to accept
// on a shared handle and the OS decides, which is historically lopsided. On
// Linux it is SCHED_RR and the primary round-robins. The lab charts per-worker
// served counts rather than assuming either, because in-process load balancing
// is still load balancing and it is worth seeing it done badly.
//
// What clustering does NOT fix: each worker is a separate process with its own
// memory, so anything you kept in a module-level variable is now wrong in N
// different ways. That is the statelessness tax, and Lesson 03 is about paying
// it before you get here rather than after.
let shuttingDown = false;

if (WORKERS > 1 && cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', () => { if (!shuttingDown) cluster.fork(); });
  if (process.send) process.send({ ready: true, id: ID, port: PORT, pid: process.pid, workers: WORKERS });
} else {
  // 0.0.0.0 rather than 127.0.0.1: the nginx container has to reach these from
  // outside the host's loopback. That does mean the fleet is reachable from
  // your LAN while the lab is running, which is worth knowing.
  server.listen(PORT, '0.0.0.0', () => {
    if (process.send) process.send({ ready: true, id: ID, port: PORT, pid: process.pid, workers: WORKERS });
    if (!process.send) {
      console.log('  instance ' + ID + ' on ' + PORT + ' (pid ' + process.pid + ', workers ' + WORKERS + ')');
    }
  });
}

const shutdown = async () => {
  shuttingDown = true;
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The orphan reaper, and the single most important line in this file for anyone
// running the lab on Windows.
//
// Windows has no POSIX signals: `child.kill('SIGTERM')` calls TerminateProcess
// regardless of the name, and if the lab host dies hard - crash, closed
// terminal, taskkill /F - nothing tells these children to stop. They survive,
// keep holding ports 4311+, and the next `npm start` fails with EADDRINUSE for
// reasons that look nothing like the cause.
//
// The IPC channel closes when the parent goes away, for ANY reason, on every
// platform. One line, and orphans become impossible.
process.on('disconnect', () => process.exit(0));

// A graceful drain, which on Windows has to be asked for at the application
// layer because there is no signal that means it. This is what the Failure tab
// uses to show the difference between a drain and a kill.
process.on('message', async (m) => {
  // Revival has to arrive over IPC, not HTTP.
  //
  // An instance that is `dead` has closed its listener and one that is `hung`
  // never answers, so neither can receive an HTTP request telling it to come
  // back - the first version of this lab tried exactly that and instances could
  // be broken but never fixed. The supervisor holds a channel to the process
  // itself, which is the only path that still works once the socket does not.
  //
  // This is not just a lab detail: it is why orchestrators talk to a kubelet or
  // an agent on the host rather than to the application. Your control plane
  // cannot share a failure domain with the thing it is meant to rescue.
  if (m && m.type === 'revive') {
    state = 'healthy';
    extraLatencyMs = 0;
    warmingUntil = Date.now() + Number(m.warmMs || 4000);
    if (!server.listening) server.listen(PORT, '0.0.0.0');
    if (process.send) process.send({ revived: true, id: ID, warmingForMs: m.warmMs || 4000 });
    return;
  }

  if (m && m.type === 'drain') {
    server.close();
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    const deadline = Date.now() + 5000;
    while (inflight > 0 && Date.now() < deadline) await sleep(50);
    await shutdown();
  }
});
