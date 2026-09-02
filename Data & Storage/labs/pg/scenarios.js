// Labs 4 and 5: transactions, isolation levels, and locks - driven as two
// real database sessions you step through one statement at a time.
//
// This is the part of the course that a book cannot do. An isolation anomaly
// is a story about *interleaving*: session A does this, then B does that,
// then A does this and gets an answer that is wrong in a way no single
// statement could ever be wrong. You have to watch it happen in order.
//
// Session A and session B here are two genuine Postgres backends with their
// own PIDs. Nothing is simulated. Change the isolation level at the top and
// run the identical script again, and the anomaly either happens or does not.
import { runOn, session, resetSessions, knownSessions, q, CODE_MEANING } from './db.js';

// How long to wait before deciding a statement is blocked rather than slow.
// Postgres' own deadlock_timeout is 1s (set in docker-compose.yml), so this
// sits just under it.
const BLOCK_AFTER_MS = 700;

// ---------------------------------------------------------------------------
// The scripts.
//
// {{iso}} is replaced with the isolation level chosen in the UI, so the same
// script runs unchanged at every level - which is the entire point. If the
// script changed between levels, the comparison would prove nothing.
// ---------------------------------------------------------------------------
export const SCENARIOS = [
  {
    id: 'dirty-read',
    title: 'The dirty read that cannot happen',
    teaches:
      'Every textbook lists "read uncommitted" as an isolation level. Postgres accepts the syntax and then silently gives you read committed instead, because its storage engine has no way to show you an uncommitted row. Worth seeing once so you stop worrying about it.',
    levels: ['READ UNCOMMITTED', 'READ COMMITTED'],
    defaultLevel: 'READ UNCOMMITTED',
    verdict: {
      pass: 'B never saw the uncommitted title. There are no dirty reads in Postgres at any isolation level.',
      fail: 'B read uncommitted data - which would mean this is not Postgres.'
    },
    steps: [
      { s: 'A', label: 'A opens a transaction', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'A', label: 'A renames an album but does NOT commit', sql: "UPDATE albums SET title = 'UNCOMMITTED TITLE' WHERE id = 'b1';" },
      { s: 'B', label: 'B reads the same album', sql: "SELECT id, title FROM albums WHERE id = 'b1';",
        note: 'B sees the old title. It cannot see A’s uncommitted change no matter what level it asks for.' },
      { s: 'A', label: 'A rolls back', sql: 'ROLLBACK;' },
      { s: 'B', label: 'B reads once more', sql: "SELECT id, title FROM albums WHERE id = 'b1';" }
    ],
    check: async () => {
      const { rows } = await q("SELECT title FROM albums WHERE id = 'b1'");
      return { ok: rows[0].title !== 'UNCOMMITTED TITLE', detail: 'albums.b1.title = ' + rows[0].title };
    }
  },

  {
    id: 'non-repeatable-read',
    title: 'Non-repeatable read',
    teaches:
      'A reads a row twice inside one transaction and gets two different answers, because B committed in between. At READ COMMITTED every statement gets a fresh snapshot. At REPEATABLE READ the whole transaction shares one snapshot, and the second read matches the first.',
    levels: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'Both of A’s reads returned the same value - the transaction saw a stable snapshot.',
      fail: 'A’s two reads disagreed inside a single transaction. That is the anomaly.'
    },
    setup: "UPDATE tracks SET seconds = 210 WHERE id = 't1';",
    steps: [
      { s: 'A', label: 'A opens a transaction', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'A', label: 'A reads the track length', sql: "SELECT id, seconds FROM tracks WHERE id = 't1';", capture: 'first' },
      { s: 'B', label: 'B changes the length and commits', sql: "UPDATE tracks SET seconds = 999 WHERE id = 't1';" },
      { s: 'A', label: 'A reads the same row again', sql: "SELECT id, seconds FROM tracks WHERE id = 't1';", capture: 'second',
        note: 'Compare with A’s first read. At READ COMMITTED this is 999; at REPEATABLE READ it is still 210.' },
      { s: 'A', label: 'A commits', sql: 'COMMIT;' }
    ],
    compare: ['first', 'second', 'seconds']
  },

  {
    id: 'phantom',
    title: 'Phantom rows',
    teaches:
      'A asks "how many albums are featured" twice. Between the two counts, B inserts a row that matches. The row appears from nowhere - a phantom. Unlike the SQL standard, Postgres blocks phantoms at REPEATABLE READ, not just at SERIALIZABLE, because its snapshot covers ranges as well as rows.',
    levels: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'Both counts agreed. No phantom appeared inside A’s transaction.',
      fail: 'The count changed inside one transaction - a row appeared that A had never seen.'
    },
    setup: "UPDATE albums SET is_featured = (id IN ('b1','b2'));",
    steps: [
      { s: 'A', label: 'A opens a transaction', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'A', label: 'A counts featured albums', sql: 'SELECT count(*) AS featured FROM albums WHERE is_featured;', capture: 'first' },
      { s: 'B', label: 'B features another album and commits', sql: "UPDATE albums SET is_featured = true WHERE id = 'b3';" },
      { s: 'A', label: 'A counts again', sql: 'SELECT count(*) AS featured FROM albums WHERE is_featured;', capture: 'second' },
      { s: 'A', label: 'A commits', sql: 'COMMIT;' }
    ],
    compare: ['first', 'second', 'featured']
  },

  {
    id: 'lost-update',
    title: 'The lost update',
    teaches:
      'The classic read-modify-write race, and the one most application code actually contains. Both sessions read a counter, both add one, both write it back. Two increments, one result. The fix is not a higher isolation level - it is to stop reading and writing in separate steps: either SELECT ... FOR UPDATE, or an atomic UPDATE ... SET n = n + 1.',
    levels: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'The counter ended at 2, or one transaction was aborted so you could retry it. No increment was silently lost.',
      fail: 'Two sessions each added 1 to 0 and the answer is 1. One update vanished with no error anywhere.'
    },
    setup: "UPDATE editorial_rules SET min_value = 0 WHERE rule = 'min_featured_albums';",
    steps: [
      { s: 'A', label: 'A begins', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'B', label: 'B begins', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'A', label: 'A reads the counter (0)', sql: "SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums';", capture: 'aRead' },
      { s: 'B', label: 'B reads the same counter (0)', sql: "SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums';", capture: 'bRead' },
      { s: 'A', label: 'A writes back 0 + 1', sql: "UPDATE editorial_rules SET min_value = 1 WHERE rule = 'min_featured_albums';" },
      { s: 'A', label: 'A commits', sql: 'COMMIT;' },
      { s: 'B', label: 'B writes back 0 + 1 too', sql: "UPDATE editorial_rules SET min_value = 1 WHERE rule = 'min_featured_albums';", mayBlock: true,
        note: 'At REPEATABLE READ or higher this raises 40001 instead of quietly overwriting.' },
      { s: 'B', label: 'B commits', sql: 'COMMIT;' }
    ],
    check: async () => {
      const { rows } = await q("SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums'");
      const v = rows[0].min_value;
      return { ok: v >= 2, detail: 'counter = ' + v + ' after two +1 increments from 0 (2 is correct, 1 means one was silently lost)' };
    }
  },

  {
    id: 'write-skew',
    title: 'Write skew — the one only SERIALIZABLE catches',
    teaches:
      'This is the anomaly worth the whole lesson. Two editors each check the rule "at least one album must stay featured", each see two featured albums, and each un-feature a different one. Neither transaction broke the rule on its own. Together they leave zero featured albums. No lock is contended, no row is touched twice, so REPEATABLE READ permits it. Only SERIALIZABLE detects that the two transactions cannot be put in any order and aborts one.',
    levels: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'At least one album is still featured - the rule held, either naturally or because Postgres aborted a transaction with 40001.',
      fail: 'Zero featured albums. Both transactions were individually correct and the invariant is broken anyway.'
    },
    setup: "UPDATE albums SET is_featured = (id IN ('b1','b2')); UPDATE editorial_rules SET min_value = 1 WHERE rule = 'min_featured_albums';",
    steps: [
      { s: 'A', label: 'Editor A begins', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'B', label: 'Editor B begins', sql: 'BEGIN ISOLATION LEVEL {{iso}};' },
      { s: 'A', label: 'A checks the rule: how many are featured?', sql: 'SELECT count(*) AS featured FROM albums WHERE is_featured;', capture: 'aSees' },
      { s: 'B', label: 'B checks the same rule', sql: 'SELECT count(*) AS featured FROM albums WHERE is_featured;', capture: 'bSees' },
      { s: 'A', label: 'A sees 2, so removing one is safe', sql: "UPDATE albums SET is_featured = false WHERE id = 'b1';" },
      { s: 'B', label: 'B sees 2, so removing one is safe', sql: "UPDATE albums SET is_featured = false WHERE id = 'b2';",
        note: 'Different row, so nothing blocks. This is why write skew is invisible to row locking.' },
      { s: 'A', label: 'A commits', sql: 'COMMIT;' },
      { s: 'B', label: 'B commits', sql: 'COMMIT;', mayBlock: true,
        note: 'At SERIALIZABLE this is where 40001 fires and B must retry.' }
    ],
    check: async () => {
      const { rows } = await q('SELECT count(*)::int AS n FROM albums WHERE is_featured');
      return { ok: rows[0].n >= 1, detail: rows[0].n + ' albums still featured (the rule requires at least 1)' };
    }
  },

  {
    id: 'deadlock',
    title: 'A deadlock, on purpose',
    teaches:
      'Two transactions take the same two locks in opposite orders. Each ends up holding what the other needs and neither can proceed. Postgres notices after deadlock_timeout (1 second here), picks a victim and aborts it with 40P01. The cure is not fewer locks - it is a consistent lock ordering everywhere in your codebase.',
    levels: ['READ COMMITTED'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'Postgres detected the cycle and aborted one transaction with 40P01. The other completed.',
      fail: 'No deadlock was detected - the steps probably did not interleave.'
    },
    setup: "UPDATE albums SET title = 'Small Machines' WHERE id = 'b1'; UPDATE albums SET title = 'After the Signal' WHERE id = 'b2';",
    steps: [
      { s: 'A', label: 'A begins', sql: 'BEGIN;' },
      { s: 'B', label: 'B begins', sql: 'BEGIN;' },
      { s: 'A', label: 'A locks album b1', sql: "UPDATE albums SET label = 'A was here' WHERE id = 'b1';" },
      { s: 'B', label: 'B locks album b2', sql: "UPDATE albums SET label = 'B was here' WHERE id = 'b2';" },
      { s: 'A', label: 'A now wants b2 — which B holds', sql: "UPDATE albums SET label = 'A wants b2' WHERE id = 'b2';", mayBlock: true,
        note: 'A is now waiting. Open the Locks panel below to see the wait edge before you continue.' },
      { s: 'B', label: 'B now wants b1 — which A holds. Cycle.', sql: "UPDATE albums SET label = 'B wants b1' WHERE id = 'b1';", mayBlock: true,
        note: 'Within a second one of these two transactions is killed with 40P01.' },
      { s: 'A', label: 'A tries to commit', sql: 'COMMIT;' },
      { s: 'B', label: 'B tries to commit', sql: 'COMMIT;' }
    ]
  },

  {
    id: 'lock-wait',
    title: 'SELECT FOR UPDATE, and the queue behind it',
    teaches:
      'The correct fix for the lost update, and its cost. A takes a row lock and holds it. B is not wrong, not aborted, just stopped - for exactly as long as A stays in its transaction. This is why long transactions are a production problem: the damage is measured in how long you hold locks, not in how much work you do.',
    levels: ['READ COMMITTED'],
    defaultLevel: 'READ COMMITTED',
    verdict: {
      pass: 'B waited for A, then proceeded on the value A left behind. No update was lost.',
      fail: 'B did not wait, so the lock was not doing its job.'
    },
    setup: "UPDATE editorial_rules SET min_value = 0 WHERE rule = 'min_featured_albums';",
    steps: [
      { s: 'A', label: 'A begins and locks the row', sql: "BEGIN; SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums' FOR UPDATE;" },
      { s: 'B', label: 'B begins and asks for the same lock', sql: "BEGIN; SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums' FOR UPDATE;", mayBlock: true,
        note: 'B is now blocked. Check the Locks panel: you can see exactly which PID waits on which.' },
      { s: 'A', label: 'A increments and commits, releasing the lock', sql: "UPDATE editorial_rules SET min_value = min_value + 1 WHERE rule = 'min_featured_albums'; COMMIT;",
        note: 'The moment this commits, B’s statement above unblocks and returns the NEW value.' },
      { s: 'B', label: 'B increments the value it now sees, and commits', sql: "UPDATE editorial_rules SET min_value = min_value + 1 WHERE rule = 'min_featured_albums'; COMMIT;" }
    ],
    check: async () => {
      const { rows } = await q("SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums'");
      return { ok: rows[0].min_value === 2, detail: 'counter = ' + rows[0].min_value + ' (2 means both increments survived)' };
    }
  }
];

const byId = new Map(SCENARIOS.map(s => [s.id, s]));

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------
let run = null;

// A statement that blocks would hold the HTTP request open until the lock
// clears, which could be never. Instead: start it, wait BLOCK_AFTER_MS, and if
// it has not finished, report it as blocked and keep the promise. A later step
// (usually the other session committing) is what resolves it, and we attach
// the outcome to the run then.
const pending = new Map();

// Starts a statement that might block, and hands back within BLOCK_AFTER_MS
// whatever we know by then. The outcome is written straight onto the history
// entry when it eventually lands, so a statement that was blocked at step 5
// and killed by the deadlock detector at step 6 ends up showing its 40P01 on
// the step that issued it - which is where a learner looks for it.
function raceBlock(name, sql, entry) {
  const p = runOn(name, sql).then(
    (res) => {
      pending.delete(name);
      Object.assign(entry, res);
      if (entry.blocked) {
        entry.blocked = false;
        entry.wasBlocked = true;
      }
      if (res.code) entry.meaning = CODE_MEANING[res.code] || null;
      return res;
    },
    (err) => {
      pending.delete(name);
      Object.assign(entry, { ok: false, error: String(err.message || err) });
      return entry;
    }
  );
  pending.set(name, { promise: p, sql, entry, since: Date.now() });
  return Promise.race([
    p,
    new Promise(resolve => setTimeout(() => resolve({ blocked: true, sql }), BLOCK_AFTER_MS))
  ]);
}

// Anything still pending gets a moment to land before we report state - this
// is what makes "A commits" visibly release "B is waiting", and what gives the
// deadlock detector (deadlock_timeout = 1s) time to fire.
async function collectResolved(timeoutMs = 1500) {
  if (pending.size === 0) return [];
  const entries = [...pending.values()];
  await Promise.race([
    Promise.all(entries.map(e => e.promise)),
    new Promise(r => setTimeout(r, timeoutMs))
  ]);
  return entries.filter(e => !pending.has(e.entry.session)).map(e => e.entry);
}

export async function start(id, level) {
  const sc = byId.get(id);
  if (!sc) return { ok: false, error: 'Unknown scenario: ' + id };

  await reset();
  if (sc.setup) {
    for (const stmt of sc.setup.split(';').map(s => s.trim()).filter(Boolean)) await q(stmt);
  }

  const isolation = sc.levels.includes(level) ? level : sc.defaultLevel;
  // A statement_timeout means a scenario that goes wrong fails loudly in a few
  // seconds instead of wedging the lab.
  for (const name of ['A', 'B']) {
    await runOn(name, "SET statement_timeout = '15s'");
    await runOn(name, "SET lock_timeout = '10s'");
  }

  run = { id, isolation, cursor: 0, history: [], captures: {}, done: false };
  return state(sc);
}

export async function step() {
  if (!run) return { ok: false, error: 'No scenario running. Start one first.' };
  const sc = byId.get(run.id);
  if (run.cursor >= sc.steps.length) return state(sc);

  const st = sc.steps[run.cursor];
  const sql = st.sql.replace(/\{\{iso\}\}/g, run.isolation);

  // The entry is created first so a statement that blocks can be patched in
  // place once it finally resolves.
  const entry = { n: run.cursor + 1, session: st.s, label: st.label, note: st.note || null, sql };
  run.history.push(entry);
  run.cursor += 1;

  const result = st.mayBlock ? await raceBlock(st.s, sql, entry) : await runOn(st.s, sql);
  if (!st.mayBlock || !result.blocked) {
    Object.assign(entry, result);
    if (result.code) entry.meaning = CODE_MEANING[result.code] || null;
  } else {
    entry.blocked = true;
  }
  if (st.capture && entry.rows && entry.rows.length) run.captures[st.capture] = entry.rows[0];

  // Give anything still blocked a chance to finish now that this step has run.
  const freed = await collectResolved();
  for (const e of freed) {
    if (e.wasBlocked && !e.resolvedNote) {
      e.unblockedBy = run.cursor;
      e.resolvedNote = e.ok === false
        ? 'This statement waited, and then Postgres aborted it (' + e.code + ') at step ' + run.cursor + '.'
        : 'This statement was blocked, and step ' + run.cursor + ' released it.';
    }
  }

  if (run.cursor >= sc.steps.length) {
    run.done = true;
    run.verdict = await verdictFor(sc);
  }
  return state(sc);
}

export async function runAll() {
  if (!run) return { ok: false, error: 'No scenario running.' };
  const sc = byId.get(run.id);
  while (run.cursor < sc.steps.length) await step();
  return state(sc);
}

async function verdictFor(sc) {
  // A serialization failure or a deadlock anywhere in the history means
  // Postgres refused the anomaly rather than allowing it. That is a pass even
  // if the data check is ambiguous.
  const aborted = run.history.find(h => h.code === '40001' || h.code === '40P01');
  if (sc.id === 'deadlock') {
    return aborted
      ? { ok: true, text: sc.verdict.pass, detail: 'Victim aborted with ' + aborted.code + '.', code: aborted.code }
      : { ok: false, text: sc.verdict.fail, detail: 'No 40P01 appeared in this run.' };
  }
  if (aborted) {
    return {
      ok: true,
      text: sc.verdict.pass,
      detail: 'Postgres raised ' + aborted.code + ' rather than allow the anomaly. Your application must catch this and retry.',
      code: aborted.code
    };
  }
  if (sc.check) {
    const c = await sc.check();
    return { ok: c.ok, text: c.ok ? sc.verdict.pass : sc.verdict.fail, detail: c.detail };
  }
  if (sc.compare) {
    const [a, b, field] = sc.compare;
    const va = run.captures[a]?.[field];
    const vb = run.captures[b]?.[field];
    const same = String(va) === String(vb);
    return {
      ok: same,
      text: same ? sc.verdict.pass : sc.verdict.fail,
      detail: 'first read = ' + va + ', second read = ' + vb
    };
  }
  return { ok: true, text: 'Scenario finished.', detail: '' };
}

function state(sc) {
  return {
    ok: true,
    scenario: { id: sc.id, title: sc.title, teaches: sc.teaches, levels: sc.levels, total: sc.steps.length },
    isolation: run.isolation,
    cursor: run.cursor,
    done: run.done,
    verdict: run.verdict || null,
    history: run.history,
    // The real backend PIDs, so the UI can show that A and B are two genuine
    // Postgres processes rather than a story about two Postgres processes.
    sessions: knownSessions(),
    next: run.cursor < sc.steps.length
      ? { n: run.cursor + 1, session: sc.steps[run.cursor].s, label: sc.steps[run.cursor].label }
      : null,
    waiting: [...pending.keys()]
  };
}

export function current() {
  if (!run) return { ok: true, idle: true, scenarios: SCENARIOS.map(publicShape) };
  return state(byId.get(run.id));
}

const publicShape = (s) => ({
  id: s.id, title: s.title, teaches: s.teaches, levels: s.levels,
  defaultLevel: s.defaultLevel, steps: s.steps.length
});

export const catalogue = () => SCENARIOS.map(publicShape);

export async function reset() {
  pending.clear();
  await resetSessions();
  // Put the rows every scenario touches back where they started.
  await q("UPDATE albums SET is_featured = (id IN ('b1','b2'))");
  await q("UPDATE editorial_rules SET min_value = 1 WHERE rule = 'min_featured_albums'");
  await q("UPDATE tracks SET seconds = 210 WHERE id = 't1'");
  await q("UPDATE albums SET title = 'Small Machines', label = 'Coldwater' WHERE id = 'b1'");
  await q("UPDATE albums SET title = 'After the Signal', label = 'Fieldnote' WHERE id = 'b2'");
  await session('A');
  await session('B');
  run = null;
  return { ok: true, reset: true };
}

// ---------------------------------------------------------------------------
// The lock view. This is the query to remember: it answers "who is blocking
// whom", which is the only question that matters during a production incident.
// ---------------------------------------------------------------------------
export async function locks() {
  const { rows } = await q(
    "SELECT w.pid AS waiting_pid,\n" +
    "       w.state AS waiting_state,\n" +
    "       left(w.query, 90) AS waiting_query,\n" +
    "       w.wait_event_type, w.wait_event,\n" +
    "       b.pid AS blocking_pid,\n" +
    "       left(b.query, 90) AS blocking_query,\n" +
    "       round(extract(epoch FROM (now() - w.query_start))::numeric, 1) AS waiting_seconds\n" +
    "  FROM pg_stat_activity w\n" +
    "  LEFT JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ON true\n" +
    "  LEFT JOIN pg_stat_activity b ON b.pid = bp.pid\n" +
    " WHERE w.datname = current_database()\n" +
    "   AND w.pid <> pg_backend_pid()\n" +
    "   AND (cardinality(pg_blocking_pids(w.pid)) > 0 OR w.state = 'idle in transaction')\n" +
    " ORDER BY waiting_seconds DESC NULLS LAST"
  );
  const held = await q(
    "SELECT l.pid, l.locktype, l.mode, l.granted, c.relname AS relation\n" +
    "  FROM pg_locks l\n" +
    "  LEFT JOIN pg_class c ON c.oid = l.relation\n" +
    " WHERE l.pid <> pg_backend_pid()\n" +
    "   AND (c.relname IS NULL OR c.relname IN ('albums','tracks','plays','editorial_rules'))\n" +
    " ORDER BY l.granted, l.pid"
  );
  return { blocking: rows, held: held.rows, sessions: [] };
}
