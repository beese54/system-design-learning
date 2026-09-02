// Lab 6: the N+1 you already met, now with a real database underneath it -
// and Lab 7: what a connection pool does when you ask it for more than it has.
//
// In the API Design course the "REST (naive)" bar on the compare chart was 4
// HTTP round trips. That was only half the bill. Each of those requests also
// ran queries, and this is where you find out how many.
import { q, timed, pool, resetCounters, readCounters, POOL_SIZE, CONFIG } from './db.js';
import pg from 'pg';

// ---------------------------------------------------------------------------
// Three ways to build the same artist page.
// ---------------------------------------------------------------------------

// 1. The way an ORM does it if you loop in application code. One query for the
//    artist, one for the albums, then one per album for its tracks. Correct,
//    readable, and it issues a query count that grows with your data.
async function nPlusOne(artistId) {
  resetCounters();
  const t0 = performance.now();

  const artist = (await q('SELECT * FROM artists WHERE id = $1', [artistId])).rows[0];
  const albums = (await q('SELECT * FROM albums WHERE artist_id = $1 ORDER BY year', [artistId])).rows;
  for (const album of albums) {
    album.tracks = (await q('SELECT * FROM tracks WHERE album_id = $1 ORDER BY position', [album.id])).rows;
  }

  const c = readCounters();
  return {
    label: 'N+1 (a query per album)',
    queries: c.queries,
    ms: Math.round((performance.now() - t0) * 100) / 100,
    dbMs: c.ms,
    albums: albums.length,
    tracks: albums.reduce((s, a) => s + a.tracks.length, 0),
    note: 'Query count = 2 + one per album. Add a hundred albums and this issues a hundred more queries.'
  };
}

// 2. One join, reassembled in application code. The database does the matching
//    once; the rows come back flat and get nested here.
async function oneJoin(artistId) {
  resetCounters();
  const t0 = performance.now();

  const rows = (await q(
    'SELECT * FROM artist_pages WHERE artist_id = $1 ORDER BY year, position', [artistId]
  )).rows;

  const albums = new Map();
  for (const r of rows) {
    if (!albums.has(r.album_id)) albums.set(r.album_id, { id: r.album_id, title: r.album_title, year: r.year, tracks: [] });
    albums.get(r.album_id).tracks.push({ id: r.track_id, title: r.track_title, seconds: r.seconds });
  }

  const c = readCounters();
  return {
    label: 'One join, nested in app code',
    queries: c.queries,
    ms: Math.round((performance.now() - t0) * 100) / 100,
    dbMs: c.ms,
    albums: albums.size,
    tracks: rows.length,
    note: 'One query regardless of how many albums exist. The artist columns repeat on every row - that is the trade.'
  };
}

// 3. One query that returns the finished shape. The nesting happens in the
//    database, so the wire carries no repeated artist columns at all.
async function oneQueryJson(artistId) {
  resetCounters();
  const t0 = performance.now();

  const res = await q(
    "SELECT jsonb_build_object(\n" +
    "         'id', a.id, 'name', a.name, 'country', a.country,\n" +
    "         'albums', coalesce(jsonb_agg(alb ORDER BY alb->>'year') FILTER (WHERE alb IS NOT NULL), '[]'::jsonb)\n" +
    "       ) AS page\n" +
    "  FROM artists a\n" +
    "  LEFT JOIN LATERAL (\n" +
    "         SELECT jsonb_build_object(\n" +
    "                  'id', b.id, 'title', b.title, 'year', b.year,\n" +
    "                  'tracks', (SELECT jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'seconds', t.seconds)\n" +
    "                                              ORDER BY t.position)\n" +
    "                               FROM tracks t WHERE t.album_id = b.id)\n" +
    "                ) AS alb\n" +
    "           FROM albums b WHERE b.artist_id = a.id\n" +
    "       ) albs ON true\n" +
    " WHERE a.id = $1\n" +
    " GROUP BY a.id, a.name, a.country", [artistId]
  );

  const page = res.rows[0]?.page ?? { albums: [] };
  const c = readCounters();
  return {
    label: 'One query, shaped in SQL',
    queries: c.queries,
    ms: Math.round((performance.now() - t0) * 100) / 100,
    dbMs: c.ms,
    albums: page.albums.length,
    tracks: page.albums.reduce((s, a) => s + (a.tracks?.length || 0), 0),
    note: 'The database returns the exact document the API wants. Fast, and harder to read six months later - a real trade, not a free win.'
  };
}

export async function artistPage(artistId = 'a1') {
  const results = [];
  results.push(await nPlusOne(artistId));
  results.push(await oneJoin(artistId));
  results.push(await oneQueryJson(artistId));

  const missing = (await q(
    "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'idx_tracks_album'"
  )).rows[0].n === 0;

  return {
    scenario: 'Build the artist page for ' + artistId + ': artist + albums + every track',
    results,
    indexHint: missing
      ? 'tracks(album_id) is NOT indexed right now. Every one of those per-album queries is scanning 22,000 tracks. Add idx_tracks_album in the Indexes tab and run this again.'
      : 'tracks(album_id) is indexed, so the per-album lookups are cheap - but there are still N of them.',
    readMe: 'queries = statements sent to Postgres. Fewer queries is usually better, but read the notes: the last row buys its speed with SQL you have to maintain.'
  };
}

// ---------------------------------------------------------------------------
// Lab 7: pool saturation.
//
// The pool is capped at POOL_SIZE. Ask for more concurrency than that and the
// extra work does not fail - it queues, invisibly, inside your application.
// The queue shows up as latency your database metrics will not explain,
// because from Postgres' point of view nothing was slow.
// ---------------------------------------------------------------------------
export async function poolPressure(concurrency = 24, workMs = 50) {
  const n = Math.min(Math.max(Number(concurrency) || 24, 1), 200);
  const sleep = Math.min(Math.max(Number(workMs) || 50, 1), 500);

  const t0 = performance.now();
  const timings = await Promise.all(
    Array.from({ length: n }, async () => {
      const queued0 = performance.now();
      const client = await pool.connect();          // this is where waiting happens
      const waitedMs = performance.now() - queued0;
      try {
        const ran0 = performance.now();
        await client.query('SELECT pg_sleep($1)', [sleep / 1000]);
        return { waitedMs, ranMs: performance.now() - ran0 };
      } finally {
        client.release();
      }
    })
  );
  const total = performance.now() - t0;

  const waits = timings.map(t => t.waitedMs).sort((a, b) => a - b);
  const pct = (p) => Math.round(waits[Math.min(waits.length - 1, Math.floor(waits.length * p))] * 10) / 10;

  return {
    poolSize: POOL_SIZE,
    concurrency: n,
    workMsEach: sleep,
    totalMs: Math.round(total),
    // With a pool of P, N jobs of D ms each take about ceil(N/P) * D.
    theoreticalMs: Math.ceil(n / POOL_SIZE) * sleep,
    queueWait: { p50: pct(0.5), p95: pct(0.95), max: Math.round(waits[waits.length - 1] * 10) / 10 },
    verdict: n <= POOL_SIZE
      ? 'Concurrency fits inside the pool, so nothing queued. Every request paid only for its own work.'
      : 'Concurrency exceeded the pool by ' + (n - POOL_SIZE) + '. The extra requests waited for a connection before doing any work at all - that wait is pure latency your database never sees.',
    readMe: 'Sizing rule of thumb: connections ~= cores x 2 + effective spindles, then measure. A bigger pool is not free - every connection is a backend process on the server.'
  };
}

// How many connections the server allows, and how many are in use. Worth
// looking at before you decide to raise the pool size.
export async function connectionBudget() {
  const { rows } = await q(
    "SELECT (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,\n" +
    "       (SELECT count(*)::int FROM pg_stat_activity) AS current_total,\n" +
    "       (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS current_db,\n" +
    "       (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'idle in transaction') AS idle_in_transaction"
  );
  return { ...rows[0], appPoolSize: POOL_SIZE };
}

// Connect-per-request, so the cost the pool removes is measurable rather than
// asserted. This is what your app did before somebody added a pool.
export async function connectCost(rounds = 5) {
  const n = Math.min(Math.max(Number(rounds) || 5, 1), 25);
  const { Client } = pg;

  const coldT0 = performance.now();
  for (let i = 0; i < n; i++) {
    const c = new Client(CONFIG);
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
  }
  const coldMs = (performance.now() - coldT0) / n;

  const warmT0 = performance.now();
  for (let i = 0; i < n; i++) await q('SELECT 1');
  const warmMs = (performance.now() - warmT0) / n;

  return {
    rounds: n,
    newConnectionMs: Math.round(coldMs * 100) / 100,
    pooledMs: Math.round(warmMs * 100) / 100,
    ratio: Math.round((coldMs / Math.max(warmMs, 0.001)) * 10) / 10,
    note: 'Each new connection forks a backend process on the server. That is the fixed cost a pool amortises away.'
  };
}
