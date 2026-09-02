// The one connection pool, plus the instrumentation the labs need.
//
// A pool is not an optimisation you add later. Opening a Postgres connection
// forks a backend process on the server - tens of milliseconds and a few MB of
// RAM, every time. The pool is what turns "connect per request" into "borrow
// per request". Lesson 07 makes you size one.
import pg from 'pg';

const { Pool, Client } = pg;

export const CONFIG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'lab',
  password: process.env.PGPASSWORD || 'lab',
  database: process.env.PGDATABASE || 'catalogue'
};

// Deliberately small. A pool of 8 against a laptop Postgres is realistic, and
// a small pool is the only way the saturation demo in Lab 6 shows anything.
export const POOL_SIZE = Number(process.env.POOL_SIZE || 8);

export const pool = new Pool({
  ...CONFIG,
  max: POOL_SIZE,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// Per-request instrumentation. The UI charts these, so every "queries: 45"
// you see in a panel is counted here, not estimated.
let counters = { queries: 0, ms: 0 };
export const resetCounters = () => { counters = { queries: 0, ms: 0 }; };
export const readCounters = () => ({ ...counters, ms: Math.round(counters.ms * 100) / 100 });

export async function q(text, params = []) {
  const t0 = performance.now();
  try {
    return await pool.query(text, params);
  } finally {
    counters.queries += 1;
    counters.ms += performance.now() - t0;
  }
}

// Same as q(), but returns rows and the wall time for this single statement -
// used wherever the lesson is about how long one query took.
export async function timed(text, params = []) {
  const t0 = performance.now();
  const res = await q(text, params);
  return { rows: res.rows, rowCount: res.rowCount, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Named sessions.
//
// The transaction and lock labs need two connections that stay open across
// several HTTP requests, because that is the only way to hold a transaction
// open and watch a second one block on it. Pool clients would be returned
// between requests, so these are dedicated Clients, kept in a map.
// ---------------------------------------------------------------------------
const sessions = new Map();

export async function session(name) {
  let s = sessions.get(name);
  if (s && !s.ended) return s;
  const client = new Client(CONFIG);
  await client.connect();
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  s = { name, client, pid: rows[0].pid, inTx: false, ended: false, log: [] };
  sessions.set(name, s);
  return s;
}

export function knownSessions() {
  return [...sessions.values()].map(s => ({ name: s.name, pid: s.pid, inTx: s.inTx }));
}

// Runs one statement on a named session and records what happened. Errors are
// returned, not thrown: in these labs a serialization failure or a deadlock is
// the expected result, not a crash.
export async function runOn(name, sql, params = []) {
  const s = await session(name);
  const t0 = performance.now();
  try {
    const res = await s.client.query(sql, params);
    const out = {
      ok: true,
      sql,
      rows: res.rows,
      rowCount: res.rowCount,
      command: res.command,
      ms: Math.round((performance.now() - t0) * 100) / 100
    };
    if (/^\s*begin/i.test(sql)) s.inTx = true;
    if (/^\s*(commit|rollback)/i.test(sql)) s.inTx = false;
    s.log.push(out);
    return out;
  } catch (err) {
    // Postgres error codes are the useful part: 40001 = serialization failure,
    // 40P01 = deadlock detected, 23505 = unique violation. The lessons refer
    // to them by number, so surface them.
    const out = {
      ok: false,
      sql,
      error: err.message,
      code: err.code,
      meaning: CODE_MEANING[err.code] || null,
      ms: Math.round((performance.now() - t0) * 100) / 100
    };
    // A failed statement inside a transaction aborts it; the session is only
    // usable again after a rollback, so do that for the learner.
    if (s.inTx && err.code !== '40001' && err.code !== '40P01') {
      try { await s.client.query('ROLLBACK'); s.inTx = false; } catch { /* already gone */ }
    } else if (err.code === '40001' || err.code === '40P01') {
      try { await s.client.query('ROLLBACK'); s.inTx = false; } catch { /* already gone */ }
    }
    s.log.push(out);
    return out;
  }
}

export const CODE_MEANING = {
  '40001': 'serialization_failure - Postgres could not order these transactions safely, so it aborted one. Retrying is the correct response.',
  '40P01': 'deadlock_detected - two transactions were each holding what the other needed. Postgres broke the tie by killing one.',
  '23505': 'unique_violation - a UNIQUE constraint did its job.',
  '23503': 'foreign_key_violation - the row you referenced does not exist.',
  '23514': 'check_violation - a CHECK constraint did its job.',
  '55P03': 'lock_not_available - NOWAIT was set and the row was already locked.',
  '57014': 'query_canceled - a statement_timeout or lock_timeout fired.'
};

// Ends every open transaction and closes the named sessions. The labs call
// this on "reset" so a half-finished scenario cannot poison the next one.
export async function resetSessions() {
  for (const s of sessions.values()) {
    try { await s.client.query('ROLLBACK'); } catch { /* not in a transaction */ }
    try { await s.client.end(); } catch { /* already closed */ }
    s.ended = true;
  }
  sessions.clear();
}

export async function ping() {
  // Reading lab_ready rather than plays is deliberate: plays exists (empty)
  // while the seed is still running, so a count against it would let the lab
  // start up against a half-loaded database. lab_ready is written by the seed's
  // final statement, so this query fails until everything is really there.
  const { rows } = await pool.query(
    "SELECT current_setting('server_version') AS version,\n" +
    "       (SELECT count(*) FROM plays) AS plays,\n" +
    "       (SELECT seeded_at FROM lab_ready LIMIT 1) AS seeded_at"
  );
  return { ok: true, version: rows[0].version, plays: Number(rows[0].plays), pool: POOL_SIZE, ...CONFIG, password: undefined };
}
