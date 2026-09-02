// The lab host: serves the UI and the control plane on :4300.
//
// Run:  npm run db:up && npm install && npm start
//
// Nothing here is a framework. As in Courses 1 and 2, you should be able to
// read every decision the server makes in one sitting.
//
// What this process does NOT do is generate load. The driver runs in its own
// worker threads for a reason: this event loop is busy serving the UI, and its
// turns would land directly in the latency numbers it is meant to report.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { waitForDb } from './db/wait.js';
import { pool } from './db/pool.js';
import * as state from './bench/state.js';
import * as capacity from './bench/capacity.js';
import * as scaling from './bench/scaling.js';
import * as balancing from './bench/balancing.js';
import * as stateless from './bench/stateless.js';
import * as reliability from './bench/reliability.js';
import * as nginx from './bench/nginx.js';
import * as sup from './fleet/supervisor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4300);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    ...headers
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

// One flat table, keyed "METHOD /path". No router, no path params - every
// handler is a one-line adapter onto a bench module, so the interesting code is
// never in this file.
const ROUTES = {
  'GET /health': async () => ({ ok: true, fleet: sup.list().length }),
  'GET /api/state': async () => state.snapshot(),
  'POST /api/preflight': async () => capacity.preflight(),

  // Tab 1 - Capacity
  'POST /api/capacity/ramp': async (b) => capacity.ramp({ mode: b.mode, durationMs: num(b.durationMs, 3000) }),
  'POST /api/capacity/omission': async (b) => capacity.omission({ mode: b.mode }),
  'POST /api/capacity/noise': async (b) => capacity.noise({ mode: b.mode, repeats: num(b.repeats, 4) }),

  // Tabs 2 and 3 - Vertical and Horizontal
  'POST /api/scaling/vertical': async (b) => scaling.vertical({ mode: b.mode }),
  'POST /api/scaling/horizontal': async (b) => scaling.horizontal({ mode: b.mode }),
  'POST /api/scaling/control': async (b) => scaling.controlExperiment({ instances: num(b.instances, 4) }),

  // Tab 4 - Balancer
  'GET /api/balancer/policies': async () => ({ policies: balancing.policies() }),
  'POST /api/balancer/compare': async (b) => balancing.compare({
    mode: b.mode, instances: num(b.instances, 4), degrade: b.degrade ?? 'slow'
  }),
  'POST /api/balancer/zombie': async (b) => balancing.zombie({ instances: num(b.instances, 4) }),
  'POST /api/balancer/policy': async (b) => state.lab.lb.setPolicy(String(b.policy || 'round-robin')),

  // Tab 5 - Stateless
  'POST /api/stateless/inmemory': async (b) => stateless.inMemory({ instances: num(b.instances, 4) }),
  'POST /api/stateless/sticky': async (b) => stateless.sticky({ instances: num(b.instances, 4) }),
  'POST /api/stateless/shared': async (b) => stateless.shared({ instances: num(b.instances, 4) }),

  // Tabs 6 and 7 - Health and Failure
  'GET /api/health/faults': async () => ({ faults: reliability.faults(), config: reliability.checkConfig() }),
  'POST /api/health/checkpath': async (b) => reliability.checkPath(String(b.path || '/readyz')),
  'POST /api/health/inject': async (b) => reliability.inject(String(b.id), String(b.state), b.opts || {}),
  'POST /api/health/revive': async (b) => reliability.revive(String(b.id)),
  'POST /api/health/detect': async (b) => reliability.detectionTime({ fault: b.fault, instances: num(b.instances, 4) }),
  'POST /api/health/cascade': async (b) => reliability.cascade({ instances: num(b.instances, 4) }),
  'POST /api/failure/outage': async (b) => reliability.outage({
    instances: num(b.instances, 4), fault: b.fault || 'dead', ratePerSec: num(b.ratePerSec, 120), retry: b.retry !== false
  }),

  // Tab 8 - The real thing
  'GET /api/nginx/available': async () => nginx.available(),
  'GET /api/nginx/mapping': async () => ({ mapping: nginx.mapping() }),
  'POST /api/nginx/hop': async () => nginx.hopCost(),
  'POST /api/nginx/behaviour': async (b) => nginx.behaviour({ fault: b.fault || 'dead' }),

  // Fleet control, shared by every tab
  'POST /api/fleet/scale': async (b) => state.ensureFleet(num(b.size, 1), num(b.workers, 1)),
  'POST /api/fleet/kill': async (b) => { const r = sup.killOne(String(b.id)); state.syncBalancer(); return r; },
  'POST /api/fleet/drain': async (b) => { const r = await sup.drainOne(String(b.id)); state.syncBalancer(); return r; },
  'GET /api/fleet/stats': async () => ({ instances: await sup.stats() })
};

// Only one experiment at a time. Two sweeps sharing this machine would each
// measure the other, and both would be wrong - so the lab refuses rather than
// producing two plausible-looking numbers.
let busy = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost:' + PORT));

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      return res.end();
    }

    const key = req.method + ' ' + url.pathname;
    const handler = ROUTES[key];

    if (handler) {
      const measuring = req.method === 'POST' && !key.includes('/fleet/') && !key.includes('/policy') && !key.includes('/inject') && !key.includes('/revive') && !key.includes('/checkpath');
      if (measuring && busy) {
        return send(res, 409, {
          ok: false,
          error: `Already running "${busy}". Only one measurement at a time - two sweeps sharing this machine would each measure the other.`
        });
      }
      if (measuring) busy = key;

      const body = req.method === 'POST' ? await readBody(req) : null;
      try {
        const out = await handler(body, url);
        return send(res, out && out.ok === false ? 400 : 200, out);
      } finally {
        if (measuring) busy = null;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return send(res, 404, { ok: false, error: 'No route at ' + url.pathname });
    }

    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(HERE, 'ui', rel));
    if (!file.startsWith(join(HERE, 'ui'))) return send(res, 403, { ok: false, error: 'nope' });
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(bytes);
  } catch (err) {
    if (err && err.code === 'ENOENT') return send(res, 404, { ok: false, error: 'Not found: ' + url.pathname });
    console.error(err);
    return send(res, 500, { ok: false, error: String(err.message || err) });
  }
});

const banner = (db, b) => {
  console.log('\n  Scaling & Load Balancing Lab');
  console.log('  ------------------------------------------------');
  console.log('  Visual lab   http://localhost:' + PORT + '/');
  console.log('  Balancer     http://127.0.0.1:' + state.LB_PORT + '  (the front door under test)');
  console.log('  Instances    127.0.0.1:' + sup.PORT_BASE + '-' + sup.PORT_MAX);
  console.log('  Postgres     ' + db.version.split(' ')[0] + ' on ' + db.host + ':' + db.port);
  console.log('  ------------------------------------------------');
  console.log('  Cores        ' + b.cores + ' logical' + (b.takenByWsl ? ', ' + b.takenByWsl + ' claimed by WSL2' : ''));
  console.log('  Fleet budget ' + b.fleet + '  (sweep ' + b.sweep.join(', ') + ')');
  if (b.smallMachine) console.log('  NOTE         small machine - the scaling curves will be short. See the README.');
  console.log('  ------------------------------------------------\n');
};

try {
  const db = await waitForDb();

  // A port held by a previous run is the most confusing possible startup
  // failure. Say so plainly instead of dying with EADDRINUSE.
  await state.init();
  const stale = await sup.surveyPorts();
  if (stale.length) {
    console.log('  Found ' + stale.length + ' instance(s) from a previous run still listening: ' +
      stale.map((s) => s.id + '@' + s.port).join(', '));
    console.log('  They are orphans. Close them, or restart this lab after they exit.\n');
  }

  server.listen(PORT, () => banner(db, state.lab.budget));
} catch (err) {
  console.error('\n  Could not start the Scaling & Load Balancing lab.\n');
  console.error('  ' + err.message + '\n');
  await pool.end().catch(() => {});
  process.exit(1);
}

const shutdown = async () => {
  // Kill the fleet before we go. The instances reap themselves when the IPC
  // channel closes, but doing it explicitly means the ports are free by the
  // time this process exits rather than a moment after.
  sup.killAll();
  try { state.lab.lb?.close(); } catch { /* already closed */ }
  await pool.end().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
