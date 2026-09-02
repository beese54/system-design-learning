# Worked solutions

Read these after attempting the exercise. Every number here came from the lab as shipped; yours
will differ a little with cache state and hardware, but the *shapes* should match. Where they do
not, that is worth chasing — a plan that differs from these is telling you something about your
machine.

---

## 1 · Read a plan cold

The interesting part of this exercise is that the folklore answer is wrong, and measuring catches
it.

**Without an index:**

```
Finalize Aggregate  125 ms
  -> Parallel Seq Scan on plays  (rows=83,373 per worker × 3)
```

250,119 rows match out of 1,000,000 — **25% of the table**. Standard advice says an index will not
be used at that selectivity.

**With `idx_plays_device`:**

```
Finalize Aggregate  12 ms
  -> Parallel Index Only Scan using idx_plays_device   ← used, and 10× faster
```

The advice was wrong here, and the reason is `count(*)`. The query needs no column outside the
index, so Postgres never touches the heap. Scanning 250,000 narrow index entries beats scanning a
million wide heap rows even at 25% selectivity.

Now the version that tests the folklore properly:

```sql
SELECT avg(ms_played) FROM plays WHERE device = 'phone';
  without index   30.5 ms   Parallel Seq Scan
  with index      27.2 ms   Parallel Bitmap Heap Scan
```

Still used. Still only ~10% better — because `ms_played` is not in the index, so all 250,000 heap
visits happen anyway.

**The answer:** an index helps when it lets you *avoid work*. Selectivity is one way to avoid work;
covering the query is another. This index is a 10× win for one query and a rounding error for
another, and shipping it depends entirely on which query you actually run. That is the real
content of the exercise.

---

## 2 · Make a query 100× cheaper

```sql
SELECT count(*) FROM plays WHERE track_id = 't5' AND played_at > now() - interval '30 days';
```

| Index | Access | Blocks |
|---|---|---|
| none | Seq Scan | 36,372 |
| `(played_at, track_id)` | Bitmap/Index scan over the whole 30-day window | thousands |
| `(track_id, played_at)` | Index Only Scan, seek then walk | **~10** |

**Why the order matters.** With `(track_id, played_at)` the index is sorted by track first, so
Postgres seeks straight to `t5` and walks forward through that track's rows in time order, stopping
at the boundary. Both predicates are served by one seek.

With `(played_at, track_id)` the leading column is the *range*. Every row in the 30-day window
(~82,000 of them) has to be examined and filtered on `track_id`. The second column filters; it
cannot seek.

**Rule: equality columns first, range columns last.**

Note also that `(track_id, played_at)` makes `idx_plays_track` redundant — a composite index serves
queries on its own prefix. Keeping both is pure cost.

Write cost measured on this lab: 2 indexes → 490 ms per 20,000 inserts; 6 indexes → 639 ms. About
**+30%**, or roughly 6% per index.

---

## 3 · Break an index four ways

```sql
-- 1. Function on the column. The index stores handle, not lower(handle).
SELECT * FROM listeners WHERE lower(handle) = 'listener_42';
-- fix: WHERE handle = 'listener_42', or an expression index on lower(handle)

-- 2. Leading wildcard. A B-tree is sorted; there is no prefix to seek to.
SELECT * FROM listeners WHERE handle LIKE '%_42';
-- fix: LIKE 'listener_%', or a trigram (pg_trgm) GIN index

-- 3. Type mismatch forcing a cast on the column side.
SELECT * FROM plays WHERE track_id::int = 5;       -- (contrived; track_id is text)
-- fix: compare in the column's own type — WHERE track_id = 't5'

-- 4. Wrong leading column: the index exists but the query does not touch its prefix.
CREATE INDEX ON plays (track_id, played_at);
SELECT count(*) FROM plays WHERE played_at > now() - interval '1 day';
-- fix: an index led by played_at
```

Two more worth knowing: **stale statistics** after a bulk load (fix: `ANALYZE`), and `OR` across
different columns, which often cannot use either index (fix: `UNION ALL` of two indexable
branches).

---

## 4 · Reproduce every anomaly

| Scenario | Breaks at | Safe at | Mechanism |
|---|---|---|---|
| dirty read | never | all levels | MVCC keeps old versions; uncommitted ones are simply not visible. `READ UNCOMMITTED` silently maps to `READ COMMITTED`. |
| non-repeatable read | READ COMMITTED | REPEATABLE READ | Statement snapshot vs transaction snapshot. |
| phantom | READ COMMITTED | REPEATABLE READ | Postgres' snapshot covers ranges, not just rows — stronger than the standard requires. |
| lost update | READ COMMITTED | REPEATABLE READ (aborts with 40001) | The second writer's update is based on a stale read; snapshot isolation detects the write-write conflict. |
| **write skew** | READ COMMITTED **and** REPEATABLE READ | SERIALIZABLE (40001) | The transactions write *different rows*, so there is no write-write conflict to detect. Only predicate-dependency tracking sees it. |
| deadlock | any (it is not an isolation anomaly) | — | Cycle detector aborts a victim with 40P01 after `deadlock_timeout`. |
| lock wait | — | — | Not an anomaly: correct behaviour, paid for in waiting. |

**Why write skew needs SERIALIZABLE and lost update does not:** in a lost update, both transactions
write the *same row*, and snapshot isolation refuses a write onto a version you did not see. In
write skew, A writes b1 and B writes b2 — no row is written twice, so there is nothing for
snapshot isolation to catch. `SERIALIZABLE` tracks that A *read* a set B *wrote* and vice versa,
which is a dependency cycle, and aborts one.

---

## 5 · Fix a lost update three ways

**1 — Atomic statement (no isolation change).** The best answer.

```sql
UPDATE editorial_rules SET min_value = min_value + 1 WHERE rule = 'min_featured_albums';
```

The read and the write are one statement, so there is no window. Correct at every isolation level,
no retry, no lock held across application code.

**2 — Explicit lock.**

```sql
BEGIN;
SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums' FOR UPDATE;
-- other sessions asking for this row now wait
UPDATE editorial_rules SET min_value = $1 WHERE rule = 'min_featured_albums';
COMMIT;
```

Use this when you must do real work in the application between the read and the write.

**3 — SERIALIZABLE plus retry.**

```js
for (let i = 0; i < 3; i++) {
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const { rows } = await db.query('SELECT min_value FROM editorial_rules WHERE rule = $1', [rule]);
    await db.query('UPDATE editorial_rules SET min_value = $1 WHERE rule = $2', [rows[0].min_value + 1, rule]);
    await db.query('COMMIT');
    break;
  } catch (e) {
    await db.query('ROLLBACK');
    if (e.code !== '40001' && e.code !== '40P01') throw e;
    await sleep(2 ** i * 50 + Math.random() * 50);
  }
}
```

**Which to ship:** the first, always, when the change is expressible as one statement. Reach for
(2) when application logic sits between read and write; reach for (3) when the invariant spans
multiple rows or tables — which is exercise 6.

---

## 6 · Design a write-skew-proof rule

Two approaches that both hold at `READ COMMITTED`. Both were verified against two live sessions;
the results below are actual output.

**A — Lock the set you are deciding over.**

```sql
BEGIN;
SELECT id FROM albums WHERE is_featured FOR UPDATE;   -- lock every featured row
-- if count >= 2, it is safe to remove one
UPDATE albums SET is_featured = false WHERE id = 'b1';
COMMIT;
```

The key detail: at `READ COMMITTED`, when B's `FOR UPDATE` unblocks it **re-evaluates the predicate
against the new row version**. b1 is no longer featured, so it drops out of B's result set and B
sees 1, not 2.

```
no lock (the anomaly)      A saw 2, B saw 2 (B blocked: false) -> featured = 0
FOR UPDATE on the set      A saw 2, B saw 1 (B blocked: true)  -> featured = 1
```

**B — Materialise the conflict into one row.**

Keep a counter both transactions must update, turning an invisible predicate conflict into an
ordinary write-write conflict Postgres already serialises:

```sql
BEGIN;
UPDATE editorial_rules SET min_value = min_value - 1
 WHERE rule = 'min_featured_albums' RETURNING min_value;   -- blocks the other writer
-- proceed only if the returned value is still >= the floor
UPDATE albums SET is_featured = false WHERE id = 'b1';
COMMIT;
```

```
counter row (serialise)    A left 1, B left 0 (B blocked: true)  -> featured = 1
```

**Costs versus SERIALIZABLE.** Both replace *aborts* with *waiting* — no retry logic, but real
contention, and (B) creates a global bottleneck: every featuring operation now serialises through
one row. `SERIALIZABLE` allows more concurrency and pays for it with 40001s under load.

**For "at least 2 admins per account":** the locking approach, scoped per account
(`SELECT ... WHERE account_id = $1 AND is_admin FOR UPDATE`). The contention is naturally
partitioned by account, so there is no global bottleneck, and you avoid retry logic entirely.
`SERIALIZABLE` would also be correct, but it is the heavier tool for an invariant that is this
easy to lock precisely.

---

## 7 · Cause and prevent a deadlock

The transcript: A locks b1, B locks b2, A requests b2 (blocks), B requests b1 (blocks) → cycle →
`40P01` after 1 second. Tab 5 shows both wait edges while it is happening.

**The fix is ordering, not timeouts:**

```sql
-- both transactions, always:
SELECT * FROM albums WHERE id IN ('b1','b2') ORDER BY id FOR UPDATE;
```

Now whichever transaction arrives second simply waits for b1 and then proceeds. No cycle is
possible because no two transactions ever hold locks in opposite order.

**The general rule:** *when a transaction must lock multiple rows, always acquire them in a total
order defined on the data — ascending primary key unless you have a reason — and make that order a
property of the code path, not of the input.* The last clause is the one that gets missed: passing
a user-supplied list of ids straight into `FOR UPDATE` inherits the caller's ordering, which is
exactly how two code paths end up disagreeing.

---

## 8 · Kill the N+1

```sql
CREATE TABLE playlists (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playlist_tracks (
  playlist_id bigint NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    text   NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
  position    int    NOT NULL,
  PRIMARY KEY (playlist_id, position),      -- ordering, no duplicate slots
  UNIQUE (playlist_id, track_id)            -- no track twice in one playlist
);
CREATE INDEX ON playlist_tracks (track_id); -- the FK Postgres will not index for you
```

The composite primary key does double duty: it enforces the ordering invariant *and* serves
"give me this playlist in order" as an index.

Single query:

```sql
SELECT pt.position, t.title, b.title AS album, a.name AS artist
  FROM playlist_tracks pt
  JOIN tracks  t ON t.id = pt.track_id
  JOIN albums  b ON b.id = t.album_id
  JOIN artists a ON a.id = b.artist_id
 WHERE pt.playlist_id = $1
 ORDER BY pt.position;
```

Reference numbers from the artist page in Tab 6: N+1 = 6 queries / 16.1 ms; one join = 1 query /
4.1 ms; SQL-shaped = 1 query / 3.7 ms.

**What you ship:** the single join. The `jsonb` version's extra 0.4 ms does not pay for the
maintenance burden here. It would, if this were a hot endpoint returning deeply nested data over a
slow network — which is exactly the judgement the exercise is asking you to make explicit.

---

## 9 · Size a pool

Measured against this lab's pool of 8, 50 ms of work per request:

| Concurrency | Total | Predicted `ceil(N/P)×D` | p95 queue wait |
|---|---|---|---|
| 8 | 67 ms | 50 ms | 14.3 ms |
| 24 | ~170 ms | 150 ms | ~110 ms |
| 40 | 267 ms | 250 ms | 213.4 ms |

The model holds well. Queue wait begins to dominate the moment concurrency exceeds the pool: at 40,
a request spends 213 ms waiting and 50 ms working — **81% of its latency is queueing**, and none of
it is visible in database metrics.

**Why raising the pool is not automatically the fix:** the queue moves rather than disappears. With
8 cores, 40 concurrent queries do not run 5× faster because the pool allows them in; they contend
for CPU and disk, and each gets slower. You have exchanged an explicit, measurable queue in your
application for an implicit one inside the database — where it is harder to see and where it also
consumes a backend process per waiter. Raise the pool when the database has idle capacity; fix the
queries or add capacity when it does not.

---

## 10 · Bloat a table

```sql
SELECT pg_size_pretty(pg_total_relation_size('plays'));
UPDATE plays SET ms_played = ms_played + 1 WHERE id <= 10000;   -- repeat 5-10 times
SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname = 'plays';
```

Each `UPDATE` writes a new version of all 10,000 rows and marks the old ones dead. Dead tuples
climb; the file grows.

**Why plain `VACUUM` does not shrink the file:** it marks dead space *reusable by this table*, it
does not return it to the operating system. Future inserts fill the gaps, so steady-state size
plateaus rather than shrinking. To actually return disk: `VACUUM FULL` (rewrites the table, takes
`ACCESS EXCLUSIVE` — an outage) or `pg_repack` (same result without the exclusive lock; use this).

**Demonstrating blocked cleanup:** in a second session run `BEGIN; SELECT 1;` and leave it. Then
`VACUUM plays` in the first. Dead tuples do not fall, because VACUUM may only remove versions older
than the oldest running snapshot, and that idle transaction is pinning it. Commit the second
session and vacuum again — now they clear. This is exactly how one forgotten `BEGIN` bloats tables
it never touched.

**The setting:** `autovacuum_vacuum_scale_factor`, default **0.2** — autovacuum waits until 20% of
the table is dead. On a large heavy-update table that is an enormous amount of garbage; lower it
per-table to 0.02–0.05.

---

## 11 · The course artifact

No worked solution — it is about *your* system. Two failure modes to avoid:

**Numbers from the internet.** "Postgres handles 10,000 writes per second" is not a measurement of
your system. At least three numbers must come from a query plan, a benchmark, or a production
metric you looked at yourself.

**No trigger for revisiting.** "We will monitor and revisit if needed" commits to nothing. Write
the threshold: *"revisit when p95 on the artist page exceeds 200 ms, or when `plays` passes 500
million rows, whichever comes first."* A decision record without a trigger is one nobody will ever
reopen — including you.
