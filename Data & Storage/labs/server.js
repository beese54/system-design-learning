// The lab host. One process serves the visual lab and every endpoint behind
// it; the database is the Postgres container from docker-compose.yml.
//
//   http://localhost:4100/            the visual Storage Lab (start here)
//   http://localhost:4100/api/schema  the live catalogue, read from Postgres
//   http://localhost:4100/api/explain POST { sql } - a real query plan
//   http://localhost:4100/health      is the database up, and how big is it
//
// Run:  npm run db:up && npm install && npm start
//
// Nothing here is a framework. As in the API Design labs, you should be able
// to read every decision the server makes in one sitting.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { pool, ping, resetCounters, readCounters } from './pg/db.js';
import { waitForDb } from './pg/wait.js';
import { explain, QUERY_LIBRARY, tableStats, schemaSnapshot } from './pg/plans.js';
import { listIndexes, createIndex, dropIndex, dropAll, writeCost, probe, CANDIDATES } from './pg/indexes.js';
import * as scenarios from './pg/scenarios.js';
import { artistPage, poolPressure, connectionBudget, connectCost } from './pg/workloads.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4100);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const c = readCounters();
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Lab-only instrumentation: how many statements this HTTP request cost.
    // The UI reads these; a real API would never advertise them.
    'X-Lab-Queries': String(c.queries),
    'X-Lab-Db-Ms': String(c.ms),
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

// The SQL console in the Plans tab runs whatever you type. That is deliberate -
// you cannot learn to read plans through a query builder. The server binds to
// localhost only and the database holds nothing but generated data, so the
// blast radius is a `docker compose down -v`. The one thing we do stop is
// dropping the tables the labs depend on, because re-seeding takes a minute
// and the lesson from that mistake is not worth the wait.
const PROTECTED = /\b(drop|truncate)\s+(table|schema|database)\b/i;

const ROUTES = {
  'GET /health': async () => ({ ok: true, db: await ping() }),

  'GET /api/schema': async () => ({ ...(await schemaSnapshot()), tables: await tableStats() }),
  'GET /api/queries': async () => ({ library: QUERY_LIBRARY }),

  'POST /api/explain': async (body) => {
    const sql = String(body.sql || '').trim().replace(/;+\s*$/, '');
    if (!sql) return { ok: false, error: 'No SQL supplied.' };
    if (PROTECTED.test(sql)) {
      return { ok: false, error: 'The lab blocks DROP/TRUNCATE of tables so the seed survives. Everything else is allowed - run it in psql if you really mean it: npm run db:psql' };
    }
    return explain(sql, { analyze: body.analyze !== false });
  },

  'GET /api/indexes': async () => listIndexes(),
  'POST /api/indexes/create': async (body) => createIndex(String(body.id || '')),
  'POST /api/indexes/drop': async (body) => dropIndex(String(body.id || '')),
  'POST /api/indexes/reset': async () => dropAll(),
  'POST /api/indexes/probe': async (body) => probe(String(body.id || '')),
  'POST /api/indexes/writecost': async (body) => writeCost(body.rows),

  'GET /api/tx': async () => ({ ...scenarios.current(), catalogue: scenarios.catalogue() }),
  'POST /api/tx/start': async (body) => scenarios.start(String(body.id || ''), String(body.level || '')),
  'POST /api/tx/step': async () => scenarios.step(),
  'POST /api/tx/runall': async () => scenarios.runAll(),
  'POST /api/tx/reset': async () => scenarios.reset(),
  'GET /api/locks': async () => scenarios.locks(),

  'GET /api/nplus1': async (_b, url) => artistPage(url.searchParams.get('artist') || 'a1'),
  'POST /api/pool': async (body) => poolPressure(body.concurrency, body.workMs),
  'GET /api/pool/budget': async () => connectionBudget(),
  'POST /api/pool/connectcost': async (body) => connectCost(body.rounds)
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost:' + PORT));
  resetCounters();

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      return res.end();
    }

    const handler = ROUTES[req.method + ' ' + url.pathname];
    if (handler) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await handler(body, url);
      return send(res, out && out.ok === false ? 400 : 200, out);
    }

    if (url.pathname.startsWith('/api/')) {
      return send(res, 404, { ok: false, error: 'No route at ' + url.pathname });
    }

    // static UI
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(HERE, 'ui', rel));
    if (!file.startsWith(join(HERE, 'ui'))) return send(res, 403, { error: 'nope' });
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(bytes);
  } catch (err) {
    if (err && err.code === 'ENOENT') return send(res, 404, { ok: false, error: 'Not found: ' + url.pathname });
    console.error(err);
    return send(res, 500, { ok: false, error: String(err.message || err), code: err.code || null });
  }
});

const banner = (db) => {
  console.log('\n  Data & Storage Lab');
  console.log('  ------------------------------------------------');
  console.log('  Visual lab   http://localhost:' + PORT + '/');
  console.log('  Postgres     ' + db.version.split(' ')[0] + ' on ' + db.host + ':' + db.port);
  console.log('  Dataset      ' + db.plays.toLocaleString('en-US') + ' plays');
  console.log('  Pool         ' + db.pool + ' connections');
  console.log('  ------------------------------------------------\n');
};

try {
  const db = await waitForDb();
  // Start from a known state: no candidate indexes, no half-run scenario.
  await dropAll();
  await scenarios.reset();
  server.listen(PORT, () => banner(db));
} catch (err) {
  console.error('\n  Could not start the Data & Storage lab.\n');
  console.error('  ' + err.message + '\n');
  await pool.end().catch(() => {});
  process.exit(1);
}

const shutdown = async () => {
  await scenarios.reset().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { CANDIDATES };
