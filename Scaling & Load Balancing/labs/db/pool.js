// The connection to the shared state store.
//
// Note what is NOT here. Course 2 instrumented this layer heavily, because that
// course was about what a query costs. This one is thin on purpose: in Course 3
// the database is a supporting actor, and every millisecond it spends should be
// boring and repeatable so that the interesting variation comes from the number
// of instances instead.
//
// One pool per PROCESS. That matters more than it looks: the lab host has a
// pool, and so does every app instance the supervisor spawns. Eight instances
// with a pool of 5 each is 40 connections, which is why the container is
// started with max_connections=200 rather than the default 100.
import pg from 'pg';

export const CONFIG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55433),
  user: process.env.PGUSER || 'lab',
  password: process.env.PGPASSWORD || 'lab',
  database: process.env.PGDATABASE || 'fleet'
};

// Deliberately small per process. A fleet of instances each holding a large
// pool is one of the ways "we scaled out" turns into "we took the database
// down" - which is Lesson 09.
export const POOL_SIZE = Number(process.env.POOL_SIZE || 5);

export const pool = new pg.Pool({
  ...CONFIG,
  max: POOL_SIZE,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// Swallowing this matters: a pooled client can be dropped by the server at any
// time, and an unhandled 'error' event on the pool takes the whole process down.
// An app instance dying because Postgres hiccuped would be indistinguishable
// from the failures Lesson 06 injects on purpose.
pool.on('error', () => {});

export const q = (text, params = []) => pool.query(text, params);

export async function timed(text, params = []) {
  const t0 = performance.now();
  const res = await q(text, params);
  return { rows: res.rows, rowCount: res.rowCount, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

// Readiness, not liveness. This deliberately reads `lab_ready` - the sentinel
// the seed writes last - rather than running `SELECT 1`. `SELECT 1` succeeds
// against a database whose tables exist and are empty, which is precisely the
// lie Lesson 05 is about.
export async function ping() {
  const { rows } = await q(`
    SELECT current_setting('server_version') AS version,
           (SELECT count(*) FROM plays)      AS plays,
           (SELECT seeded_at FROM lab_ready LIMIT 1) AS seeded_at
  `);
  return {
    version: rows[0].version,
    plays: Number(rows[0].plays),
    seededAt: rows[0].seeded_at,
    host: CONFIG.host,
    port: CONFIG.port,
    pool: POOL_SIZE
  };
}
