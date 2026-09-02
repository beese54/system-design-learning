# 03 · How a query actually runs

SQL is a *declarative* language. You write what you want; you never write how to get it. That is
the source of its power and of every performance surprise you will ever have with it, because
something else is choosing the how — and when it chooses badly, your query is slow for reasons
invisible in the query text.

That something is the planner. This lesson teaches you to read its mind.

---

## The five stages

1. **Parse** — is this valid SQL?
2. **Analyse** — do these tables and columns exist, and what types are they?
3. **Rewrite** — expand views, apply rules. (The `artist_pages` view in this lab disappears here;
   by planning time it is just a join.)
4. **Plan** — consider the possible execution strategies, estimate the cost of each, pick the
   cheapest.
5. **Execute** — run the winner.

Stage 4 is the whole ballgame. For a three-table join there are already a dozen plausible plans:
which table to read first, whether to use an index, which join algorithm for each pair. The
planner estimates a cost for each and picks the minimum.

**It estimates from statistics, not from your data.** That distinction is the source of most bad
plans, and we will come back to it.

---

## Reading a plan

Open **Tab 2 · Query plans**, pick *"Filter on an unindexed column"*, and run it. You get
something like:

```
Aggregate  (planned 1, actual 1)  19.76ms  [36372 blocks]
  -> Seq Scan on plays  (planned 1064, actual 1621)  19.5ms  [36372 blocks]
       Filter: (track_id = 't5'::text)
       Rows removed by filter: 998379
```

Read it **bottom-up and inside-out**: the deepest node runs first and feeds its parent.

- **`Seq Scan on plays`** — the access method. Postgres read the whole table.
- **`planned 1064, actual 1621`** — what the planner guessed versus what it got. Close here.
- **`Rows removed by filter: 998379`** — the number that should make you wince. Postgres read a
  million rows and threw away 998,379 of them to return 1,621. **This single line is the clearest
  "you are missing an index" signal in the whole tool.**
- **`[36372 blocks]`** — 8 KB pages touched. About 284 MB of reading to answer a question about a
  few hundred rows.

Now the same query in Lesson 04, after an index exists:

```
Aggregate  (actual 1)  1.25ms  [10 blocks]
  -> Index Only Scan using idx_plays_track  (actual 1621)  [10 blocks]
       Index Cond: (track_id = 't5'::text)
```

Ten blocks instead of 36,372. No rows removed, because the index went straight to the matching
ones. That is the shape of every index win you will ever see.

---

## The access methods, and when each is right

| Node | What it does | When it is correct |
|---|---|---|
| **Seq Scan** | Read every block. | You want a large fraction of the table. Genuinely optimal for "count all rows" — an index would be slower. |
| **Index Scan** | Walk the index, fetch each matching row from the heap. | Few matching rows, and you need columns the index does not hold. |
| **Bitmap Heap Scan** | Collect all matching row locations first, sort them, then read the heap in *page order*. | Medium number of matches. Turns scattered random reads into something closer to sequential. |
| **Index Only Scan** | The index contained every column the query needed. The table is never touched. | The cheapest read available — and it depends on VACUUM keeping the visibility map fresh (Lesson 08). |

**A sequential scan is not a bug.** If you ask for 80% of a table, reading it straight through is
the right plan and an index would be slower — every indexed row costs an extra hop to the heap.
The planner knows this. When it chooses a seq scan for a query returning three rows, the problem
is not the planner's preference; it is that the planner does not believe it will only get three
rows. Which brings us to the real skill.

---

## Join strategies

Three ways to match two sets of rows, chosen by estimated size:

- **Nested Loop** — for each row on the left, look up matches on the right. Excellent when the
  left side is tiny and the right side is indexed. Catastrophic when the planner thought the left
  side was 10 rows and it is 400,000, because it now does 400,000 lookups.
- **Hash Join** — build a hash table of the smaller side in memory, stream the larger side past
  it. The workhorse for joining two large sets.
- **Merge Join** — sort both sides, walk them together. Good when both are already sorted, e.g.
  arriving from index scans in the right order.

Run *"Join artists to albums to tracks"* in the lab and look at which one you got. Then read the
next section to understand why.

---

## The number that actually predicts slow queries

Not execution time. **The ratio between planned and actual rows.**

The lab shows this as *worst estimate*. Here is why it is the number to watch: the planner picked
a nested loop because it expected 10 rows. If it gets 400,000, it does not change its mind
partway through — the plan is already chosen. The query is now doing 400,000 index lookups
instead of one hash join, and it will be slow in a way that no amount of staring at the SQL
explains.

So when a query is inexplicably slow, the first question is never "which index should I add?" It
is **"did the planner know what it was getting into?"** A 1000× mis-estimate means the fix is
usually statistics, not indexes:

- `ANALYZE tablename` — refresh statistics. Postgres does this automatically via autovacuum, but
  after a bulk load the stats can be badly stale. This lab's seed runs `ANALYZE` at the end for
  exactly that reason; without it, every plan you read here would be a lie.
- `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS 500` — keep a finer histogram for a column with
  a skewed distribution.
- `CREATE STATISTICS` — teach the planner that two columns are *correlated*. Postgres assumes
  independence by default, so for `WHERE country = 'KR' AND city = 'Seoul'` it multiplies the two
  selectivities and estimates far too few rows.

---

## EXPLAIN versus EXPLAIN ANALYZE

- `EXPLAIN` — plan only. Nothing runs. Estimates only.
- `EXPLAIN ANALYZE` — **actually runs the query** and reports real timings and row counts.

That second point matters more than it looks. `EXPLAIN ANALYZE DELETE FROM ...` deletes the rows.
The safe habit, which this lab does for you automatically on any non-`SELECT`:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE plays SET ms_played = 0 WHERE id = 1;
ROLLBACK;
```

Always add `BUFFERS`. Time varies with cache warmth and what else the machine is doing; block
counts are stable, comparable between runs, and tell you the truth about how much work happened.
**When you benchmark a change, compare blocks first and milliseconds second.**

---

## What you should now be able to do

- [ ] Read a plan tree bottom-up and say which node ran first.
- [ ] Explain what "rows removed by filter" means and why a large value indicates a missing index.
- [ ] Name the four access methods and give a case where each is the correct choice.
- [ ] Argue why a sequential scan is sometimes the right plan.
- [ ] Explain why a bad row estimate causes a bad plan, and name three ways to fix the estimate.
- [ ] Plan a destructive statement without executing it.

**Artifact for this module:** find a genuinely slow query — in your own system if you have one,
or the worst one you can construct in this lab. Capture its `EXPLAIN (ANALYZE, BUFFERS)` output.
Write a paragraph diagnosing it that names **the specific node** where the time or the blocks go,
and **why** the planner chose it. Then fix it and capture the new plan. The artifact is the two
plans plus the paragraph — the diagnosis is the part that proves you learned something, not the
speed-up.

Next: [04 · Indexes](04-indexes.md)
