// Lab 2: reading what the planner actually did.
//
// EXPLAIN shows the plan the planner chose and what it *guessed* it would
// cost. EXPLAIN ANALYZE runs the query and shows what actually happened. The
// gap between the two is where most slow queries hide: a planner that
// estimated 12 rows and got 400,000 has already picked the wrong join.
import { pool, q } from './db.js';

// Statements that change data still change it under EXPLAIN ANALYZE - the
// query really runs. So anything that is not a plain read gets wrapped in a
// transaction we then roll back. This is the safe way to plan a write, and
// worth knowing well outside this lab.
const READ_ONLY = /^\s*(select|with|table|values)\b/i;

export async function explain(sql, { analyze = true, buffers = true } = {}) {
  const opts = ['FORMAT JSON', 'COSTS ON', 'SETTINGS ON'];
  if (analyze) {
    opts.push('ANALYZE');
    if (buffers) opts.push('BUFFERS');
  }
  const prefix = 'EXPLAIN (' + opts.join(', ') + ') ';

  const readOnly = READ_ONLY.test(sql);
  const client = await pool.connect();
  try {
    if (!readOnly) await client.query('BEGIN');
    const t0 = performance.now();
    const res = await client.query(prefix + sql);
    const wall = Math.round((performance.now() - t0) * 100) / 100;
    if (!readOnly) await client.query('ROLLBACK');

    const plan = res.rows[0]['QUERY PLAN'][0];
    return {
      ok: true,
      readOnly,
      wall,
      planningMs: plan['Planning Time'] ?? null,
      executionMs: plan['Execution Time'] ?? null,
      summary: summarise(plan.Plan),
      text: render(plan.Plan),
      raw: plan
    };
  } catch (err) {
    if (!readOnly) { try { await client.query('ROLLBACK'); } catch { /* already gone */ } }
    return { ok: false, error: err.message, code: err.code, position: err.position ?? null };
  } finally {
    client.release();
  }
}

// The numbers worth showing big: how the table was reached, how many blocks
// were touched, and how badly the planner mis-estimated.
function summarise(node) {
  const out = {
    access: [],
    buffers: 0,
    rowsPlanned: node['Plan Rows'] ?? 0,
    rowsActual: node['Actual Rows'] ?? 0,
    rowsRemoved: 0,
    worstEstimate: null
  };

  const walk = (n) => {
    if (/Scan/.test(n['Node Type'])) {
      out.access.push({
        type: n['Node Type'],
        relation: n['Relation Name'] || null,
        index: n['Index Name'] || null,
        rows: n['Actual Rows'] ?? null
      });
    }
    out.buffers += (n['Shared Hit Blocks'] || 0) + (n['Shared Read Blocks'] || 0);
    out.rowsRemoved += (n['Rows Removed by Filter'] || 0) * (n['Actual Loops'] || 1);

    // Estimation error per node, normalised so 1.0 is perfect. Past ~10x is
    // usually the reason the plan is wrong.
    const planned = (n['Plan Rows'] ?? 0) * (n['Actual Loops'] || 1);
    const actual = (n['Actual Rows'] ?? 0) * (n['Actual Loops'] || 1);
    if (planned > 0 && actual > 0) {
      const ratio = Math.max(planned / actual, actual / planned);
      if (!out.worstEstimate || ratio > out.worstEstimate.ratio) {
        out.worstEstimate = {
          node: n['Node Type'],
          planned,
          actual,
          ratio: Math.round(ratio * 10) / 10
        };
      }
    }
    (n.Plans || []).forEach(walk);
  };
  walk(node);

  out.seqScans = out.access.filter(a => /Seq Scan/.test(a.type)).length;
  out.indexScans = out.access.filter(a => /Index/.test(a.type)).length;
  return out;
}

// A compact text tree. psql's own output is excellent but very wide; this
// keeps the shape and the two numbers you read first.
function render(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const arrow = depth ? '-> ' : '';
  const rows = node['Actual Rows'] ?? '?';
  const planned = node['Plan Rows'] ?? '?';
  const ms = node['Actual Total Time'] != null ? node['Actual Total Time'].toFixed(2) + 'ms' : '';
  const loops = node['Actual Loops'] > 1 ? ' x' + node['Actual Loops'] + ' loops' : '';
  const rel = node['Relation Name'] ? ' on ' + node['Relation Name'] : '';
  const idx = node['Index Name'] ? ' using ' + node['Index Name'] : '';
  const blocks = (node['Shared Hit Blocks'] || 0) + (node['Shared Read Blocks'] || 0);

  let line = pad + arrow + node['Node Type'] + rel + idx +
             '  (planned ' + planned + ', actual ' + rows + loops + ')  ' + ms;
  if (blocks) line += '  [' + blocks + ' blocks]';

  const extras = [];
  const add = (label, value) => { if (value != null && value !== '') extras.push(pad + '     ' + label + ': ' + value); };
  add('Filter', node['Filter']);
  add('Rows removed by filter', node['Rows Removed by Filter']);
  add('Index Cond', node['Index Cond']);
  add('Hash Cond', node['Hash Cond']);
  add('Sort Key', node['Sort Key'] ? node['Sort Key'].join(', ') : null);
  if (node['Sort Method']) {
    add('Sort Method', node['Sort Method'] +
        (node['Sort Space Used'] ? '  (' + node['Sort Space Used'] + 'kB, ' + node['Sort Space Type'] + ')' : ''));
  }

  return [line, ...extras, ...(node.Plans || []).map(c => render(c, depth + 1))].join('\n');
}

// The query library the Plans tab offers. Each one exists to make a specific
// planner decision visible - none of them are filler.
export const QUERY_LIBRARY = [
  {
    id: 'point-lookup',
    label: 'Point lookup by primary key',
    teaches: 'The best case. One index, a couple of blocks, sub-millisecond - and it stays that way however big the table grows.',
    sql: "SELECT * FROM tracks WHERE id = 't5000';"
  },
  {
    id: 'unindexed-filter',
    label: 'Filter on an unindexed column',
    teaches: 'A million rows read to return a few hundred. This is the exact query Lab 3 has you fix.',
    sql: "SELECT count(*) FROM plays WHERE track_id = 't5';"
  },
  {
    id: 'range-scan',
    label: 'Time range over plays',
    teaches: 'Range predicates are what composite indexes are for, and the reason column order inside an index matters.',
    sql: "SELECT count(*) FROM plays WHERE played_at > now() - interval '7 days';"
  },
  {
    id: 'join-three',
    label: 'Join artists to albums to tracks',
    teaches: 'Watch the planner pick hash join or nested loop. It chooses on estimated row counts, not on how you wrote the SQL.',
    sql: "SELECT a.name, b.title, count(t.id) AS tracks\n  FROM artists a\n  JOIN albums b ON b.artist_id = a.id\n  JOIN tracks t ON t.album_id = b.id\n WHERE a.id = 'a1'\n GROUP BY a.name, b.title;"
  },
  {
    id: 'top-tracks',
    label: 'Top 10 tracks in the last 90 days',
    teaches: 'Aggregate a big table, then sort. Read the Sort Method line: quicksort in memory, or external merge on disk?',
    sql: "SELECT t.title, count(*) AS plays\n  FROM plays p\n  JOIN tracks t ON t.id = p.track_id\n WHERE p.played_at > now() - interval '90 days'\n GROUP BY t.title\n ORDER BY plays DESC\n LIMIT 10;"
  },
  {
    id: 'anti-join',
    label: 'Tracks nobody has ever played',
    teaches: 'NOT EXISTS becomes an anti-join. Compare it with NOT IN, which cannot, and which quietly breaks on NULLs.',
    sql: "SELECT count(*) FROM tracks t\n WHERE NOT EXISTS (SELECT 1 FROM plays p WHERE p.track_id = t.id);"
  },
  {
    id: 'function-kills-index',
    label: 'A function call that disables an index',
    teaches: 'handle is indexed by a UNIQUE constraint, but wrapping it in lower() makes that index unusable. Seq scan on 50,000 rows.',
    sql: "SELECT count(*) FROM listeners WHERE lower(handle) = 'listener_42';"
  },
  {
    id: 'sargable-rewrite',
    label: 'The same question, written so the index can help',
    teaches: 'Same answer, different shape. The predicate now touches the bare column, so the UNIQUE index is usable again.',
    sql: "SELECT count(*) FROM listeners WHERE handle = 'listener_42';"
  }
];

export async function tableStats() {
  const { rows } = await q(
    "SELECT c.relname AS table_name,\n" +
    "       c.reltuples::bigint AS est_rows,\n" +
    "       pg_size_pretty(pg_table_size(c.oid)) AS heap,\n" +
    "       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,\n" +
    "       pg_size_pretty(pg_total_relation_size(c.oid)) AS total\n" +
    "  FROM pg_class c\n" +
    "  JOIN pg_namespace n ON n.oid = c.relnamespace\n" +
    " WHERE n.nspname = 'public' AND c.relkind = 'r'\n" +
    " ORDER BY pg_total_relation_size(c.oid) DESC"
  );
  return rows;
}

// The schema tab reads this: every table, its columns, and every constraint,
// straight from the catalogue rather than from a copy of the DDL that would
// drift the first time somebody ran a migration.
export async function schemaSnapshot() {
  const cols = await q(
    "SELECT table_name, column_name, data_type, is_nullable, column_default\n" +
    "  FROM information_schema.columns\n" +
    " WHERE table_schema = 'public'\n" +
    " ORDER BY table_name, ordinal_position"
  );
  const cons = await q(
    "SELECT rel.relname AS table_name, con.conname AS name,\n" +
    "       CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY'\n" +
    "                        WHEN 'u' THEN 'UNIQUE'      WHEN 'c' THEN 'CHECK' END AS kind,\n" +
    "       pg_get_constraintdef(con.oid) AS definition\n" +
    "  FROM pg_constraint con\n" +
    "  JOIN pg_class rel ON rel.oid = con.conrelid\n" +
    "  JOIN pg_namespace n ON n.oid = rel.relnamespace\n" +
    " WHERE n.nspname = 'public'\n" +
    " ORDER BY rel.relname, con.contype"
  );
  return { columns: cols.rows, constraints: cons.rows };
}
