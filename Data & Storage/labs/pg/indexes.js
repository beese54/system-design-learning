// Lab 3: indexes, added and removed against a live million-row table.
//
// The schema ships under-indexed on purpose. Everything here is reversible,
// so the loop the lab wants you in is: run the query, read the plan, add the
// index, run it again, read the plan again, then decide whether the write
// cost was worth it. An index is a permanent tax on every INSERT, UPDATE and
// DELETE, paid so that some SELECT gets cheaper. Nobody tells you the tax;
// the Write cost panel in this lab does.
import { q, timed, pool } from './db.js';

// Only indexes named here can be created or dropped through the lab, so a
// stray click can never remove a primary key.
export const CANDIDATES = [
  {
    id: 'idx_plays_track',
    ddl: 'CREATE INDEX idx_plays_track ON plays (track_id)',
    label: 'plays (track_id)',
    buys: 'Turns "how many times was this track played" from a scan of a million rows into a bitmap index lookup.',
    costs: 'About 20-25 MB, and every insert into plays now maintains a second structure.',
    query: "SELECT count(*) FROM plays WHERE track_id = 't5';"
  },
  {
    id: 'idx_plays_played_at',
    ddl: 'CREATE INDEX idx_plays_played_at ON plays (played_at)',
    label: 'plays (played_at)',
    buys: 'Range queries over recent time stop reading the whole table. The narrower the window, the bigger the win.',
    costs: 'On a table where rows arrive in time order this index is nearly always hot at one end - which is fine, but it is still ~25 MB.',
    query: "SELECT count(*) FROM plays WHERE played_at > now() - interval '7 days';"
  },
  {
    id: 'idx_plays_track_time',
    ddl: 'CREATE INDEX idx_plays_track_time ON plays (track_id, played_at)',
    label: 'plays (track_id, played_at)  — composite, right order',
    buys: 'Answers "recent plays of THIS track" with one index. The equality column comes first, the range column second - that is the rule.',
    costs: 'Bigger than either single-column index, and it makes idx_plays_track redundant: a composite index serves queries on its leading column too.',
    query: "SELECT count(*) FROM plays WHERE track_id = 't5' AND played_at > now() - interval '30 days';"
  },
  {
    id: 'idx_plays_time_track',
    ddl: 'CREATE INDEX idx_plays_time_track ON plays (played_at, track_id)',
    label: 'plays (played_at, track_id)  — composite, wrong order',
    buys: 'Very little for the query above. Same two columns as the index before it, reversed - and now the equality on track_id cannot be used to seek.',
    costs: 'Same size as the useful one. This is the most common composite-index mistake, and it looks identical in a code review.',
    query: "SELECT count(*) FROM plays WHERE track_id = 't5' AND played_at > now() - interval '30 days';"
  },
  {
    id: 'idx_albums_artist',
    ddl: 'CREATE INDEX idx_albums_artist ON albums (artist_id)',
    label: 'albums (artist_id)  — the unindexed foreign key',
    buys: 'Postgres does NOT index foreign keys for you. Without this, "the albums of artist X" scans every album, and deleting an artist scans it again.',
    costs: 'Small. This one is almost always worth it, which is why forgetting it is such a common production bug.',
    query: "SELECT * FROM albums WHERE artist_id = 'a1';"
  },
  {
    id: 'idx_tracks_album',
    ddl: 'CREATE INDEX idx_tracks_album ON tracks (album_id)',
    label: 'tracks (album_id)  — the other unindexed foreign key',
    buys: 'The join that builds an artist page. Watch the N+1 tab before and after adding this.',
    costs: 'Small.',
    query: "SELECT * FROM tracks WHERE album_id = 'b1';"
  },
  {
    id: 'idx_listeners_lower_handle',
    ddl: 'CREATE INDEX idx_listeners_lower_handle ON listeners (lower(handle))',
    label: 'listeners (lower(handle))  — an expression index',
    buys: 'Makes the case-insensitive lookup indexable. The index stores the result of the function, so the planner can match the predicate.',
    costs: 'Only usable by queries that spell the expression exactly the same way. Write lower(handle) here and upper(handle) there and you get nothing.',
    query: "SELECT count(*) FROM listeners WHERE lower(handle) = 'listener_42';"
  },
  {
    id: 'idx_plays_covering',
    ddl: 'CREATE INDEX idx_plays_covering ON plays (track_id) INCLUDE (ms_played)',
    label: 'plays (track_id) INCLUDE (ms_played)  — covering',
    buys: 'Puts ms_played inside the index, so a query needing only those two columns never touches the table at all. Look for "Index Only Scan".',
    costs: 'Larger index. And the index-only scan only stays index-only while the visibility map is fresh, which means it depends on VACUUM having run.',
    query: "SELECT avg(ms_played) FROM plays WHERE track_id = 't5';"
  },
  {
    id: 'idx_plays_device',
    ddl: 'CREATE INDEX idx_plays_device ON plays (device)',
    label: 'plays (device)  — the marginal one',
    buys: 'About 10%. Four distinct devices across a million rows means any one of them matches ~250,000 - a quarter of the table. The planner does use this index, but the query still has to visit the heap for ms_played, so most of the work remains.',
    costs: 'Full price: ~7 MB and a share of every write, for roughly 30 ms -> 27 ms. This is the index that looks reasonable in review and is not worth shipping. Try the same index against SELECT count(*) instead and watch it become an index-only scan and a 10x win - the index did not change, the query did.',
    query: "SELECT avg(ms_played) FROM plays WHERE device = 'phone';"
  }
];

const byId = new Map(CANDIDATES.map(c => [c.id, c]));

export async function listIndexes() {
  const existing = await q(
    "SELECT i.indexrelname AS name, i.relname AS table_name,\n" +
    "       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,\n" +
    "       pg_relation_size(i.indexrelid) AS bytes,\n" +
    "       i.idx_scan AS scans, x.indisunique AS is_unique, x.indisprimary AS is_primary,\n" +
    "       pg_get_indexdef(i.indexrelid) AS definition\n" +
    "  FROM pg_stat_user_indexes i\n" +
    "  JOIN pg_index x ON x.indexrelid = i.indexrelid\n" +
    " ORDER BY i.relname, i.indexrelname"
  );
  const present = new Set(existing.rows.map(r => r.name));
  return {
    existing: existing.rows,
    candidates: CANDIDATES.map(c => ({ ...c, present: present.has(c.id) })),
    // Indexes nobody has used since the server started. In production this is
    // the first place to look for storage you can hand back.
    unused: existing.rows.filter(r => Number(r.scans) === 0 && !r.is_primary && !r.is_unique)
  };
}

export async function createIndex(id) {
  const c = byId.get(id);
  if (!c) return { ok: false, error: 'Unknown index: ' + id };
  const t0 = performance.now();
  await q(c.ddl);
  // A new index has no statistics until ANALYZE runs, and the planner will
  // not trust what it cannot measure.
  await q('ANALYZE plays');
  const { rows } = await q('SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS size', [id]);
  return { ok: true, id, buildMs: Math.round(performance.now() - t0), size: rows[0].size };
}

export async function dropIndex(id) {
  if (!byId.has(id)) return { ok: false, error: 'Unknown index: ' + id };
  await q('DROP INDEX IF EXISTS ' + id);
  return { ok: true, id };
}

// Reset the lab to its shipped state: every candidate index gone.
export async function dropAll() {
  for (const c of CANDIDATES) await q('DROP INDEX IF EXISTS ' + c.id);
  await q('ANALYZE plays');
  return { ok: true, dropped: CANDIDATES.length };
}

// ---------------------------------------------------------------------------
// The write tax.
//
// Insert a batch of rows and time it. Run this with no candidate indexes,
// then again with five of them, and the difference is the price you are
// paying on every write for the reads you made faster. Everything happens
// inside a transaction that is rolled back, so the row count never moves.
// ---------------------------------------------------------------------------
export async function writeCost(rows = 20000) {
  const n = Math.min(Math.max(Number(rows) || 20000, 1000), 100000);
  const client = await pool.connect();
  try {
    const { rows: idx } = await client.query(
      "SELECT count(*)::int AS n FROM pg_stat_user_indexes WHERE relname = 'plays'"
    );
    await client.query('BEGIN');
    const t0 = performance.now();
    await client.query(
      "INSERT INTO plays (track_id, listener_id, played_at, ms_played, device)\n" +
      " SELECT 't' || (1 + floor(random() * 22000)::int),\n" +
      "        1 + floor(random() * 50000)::bigint,\n" +
      "        now() - (random() * 30) * interval '1 day',\n" +
      "        30000 + floor(random() * 240000)::int,\n" +
      "        (ARRAY['phone','desktop','speaker','car'])[1 + floor(random() * 4)::int]\n" +
      "   FROM generate_series(1, $1)", [n]
    );
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    await client.query('ROLLBACK');
    return {
      ok: true,
      rows: n,
      indexesOnPlays: idx[0].n,
      ms,
      perRowUs: Math.round((ms * 1000 / n) * 100) / 100,
      note: 'Rolled back - the table is unchanged. Re-run this after adding indexes and compare.'
    };
  } finally {
    client.release();
  }
}

// Run one candidate's query and hand back the time plus how the table was
// reached, so the UI can put "before" and "after" side by side.
export async function probe(id) {
  const c = byId.get(id);
  if (!c) return { ok: false, error: 'Unknown index: ' + id };
  const { rows: planRows } = await q('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + c.query);
  const plan = planRows[0]['QUERY PLAN'][0];
  const access = [];
  const walk = (nd) => {
    if (/Scan/.test(nd['Node Type'])) access.push(nd['Node Type'] + (nd['Index Name'] ? ' using ' + nd['Index Name'] : ''));
    (nd.Plans || []).forEach(walk);
  };
  walk(plan.Plan);
  const blocks = (function count(nd) {
    return (nd['Shared Hit Blocks'] || 0) + (nd['Shared Read Blocks'] || 0) +
           (nd.Plans || []).reduce((s, c2) => s + count(c2), 0);
  })(plan.Plan);
  const { rows: present } = await q(
    'SELECT count(*)::int AS n FROM pg_class WHERE relname = $1', [id]
  );
  const result = await timed(c.query);
  return {
    ok: true,
    id,
    query: c.query,
    present: present[0].n > 0,
    executionMs: plan['Execution Time'],
    ms: result.ms,
    blocks,
    access,
    answer: result.rows[0] ?? null
  };
}
