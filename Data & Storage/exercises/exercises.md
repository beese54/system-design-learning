# Exercises

Every exercise has **acceptance criteria** — conditions that can fail. Try each one before reading
[`solutions.md`](solutions.md); the worked answers are worth much less if you have not first been
wrong about something.

Everything runs against the lab database. Use the UI, or open psql directly:

```bash
cd "Data & Storage/labs"
npm run db:psql
```

---

## 1 · Read a plan cold  *(Lesson 03, 20 min)*

Without running it, predict the plan for:

```sql
SELECT count(*) FROM plays WHERE device = 'phone';
```

Write down: the access method you expect, roughly how many rows will match, and whether an index
on `device` would help.

Then run it with `EXPLAIN (ANALYZE, BUFFERS)`. Then create `idx_plays_device` in Tab 3 and run it
again.

**Acceptance criteria**
- [ ] Your prediction is written down *before* you run anything.
- [ ] You can state how many rows matched and what fraction of the table that is.
- [ ] You can explain why the planner behaves as it does with the index present.
- [ ] You can say what the index costs given that behaviour.

---

## 2 · Make a query 100× cheaper  *(Lesson 04, 30 min)*

Find the plays of a specific track in a time window:

```sql
SELECT count(*) FROM plays
 WHERE track_id = 't5' AND played_at > now() - interval '30 days';
```

Get its **block count** as low as you can.

**Acceptance criteria**
- [ ] Before and after plans captured, with block counts.
- [ ] Final plan uses an index whose column order you can justify.
- [ ] You tried both `(track_id, played_at)` and `(played_at, track_id)` and can explain the
      difference in the plans, not just in the timings.
- [ ] You measured the write cost of the index you kept.

---

## 3 · Break an index four ways  *(Lesson 04, 25 min)*

With `idx_listeners_lower_handle` and the built-in unique index on `listeners.handle`, write four
queries that each *should* be able to use an index but cannot, for four different reasons.

**Acceptance criteria**
- [ ] Four queries, four distinct causes, each confirmed with `EXPLAIN`.
- [ ] For each, a one-line fix that restores index usage.
- [ ] At least one cause is not "wrapped the column in a function."

---

## 4 · Reproduce every anomaly  *(Lesson 05, 45 min)*

Work through all seven scenarios in Tab 4. For each, record: the isolation level where it breaks,
the level where it stops breaking, and — in your own words — *why*.

**Acceptance criteria**
- [ ] A table of seven rows: scenario, breaks at, safe at, mechanism.
- [ ] You can explain why `dirty-read` behaves identically at both its levels.
- [ ] You can explain why `REPEATABLE READ` stops phantoms in Postgres when the SQL standard does
      not require it.
- [ ] You can explain why `write-skew` needs `SERIALIZABLE` when `lost-update` does not.

---

## 5 · Fix a lost update three ways  *(Lesson 05, 30 min)*

The `lost-update` scenario loses an increment at `READ COMMITTED`. Fix it three different ways —
each must survive two concurrent sessions, verified in the lab:

1. Without changing the isolation level.
2. With an explicit lock.
3. With a higher isolation level plus retry logic (pseudocode is fine for the retry).

**Acceptance criteria**
- [ ] Three working fixes, each demonstrated against two real sessions.
- [ ] A sentence on which you would ship, and why.
- [ ] Your retry logic retries the whole transaction and handles both `40001` and `40P01`.

---

## 6 · Design a write-skew-proof rule  *(Lesson 05, 40 min)*

The editorial rule is "at least one album must stay featured." `SERIALIZABLE` catches violations by
aborting a transaction. Design an alternative that makes the violation **impossible** rather than
detected — no retry, correct at `READ COMMITTED`.

**Acceptance criteria**
- [ ] A working implementation in the lab database.
- [ ] It survives the `write-skew` interleaving at `READ COMMITTED`.
- [ ] You can name what your approach costs compared with `SERIALIZABLE`.
- [ ] You can say which of the two you would choose for a rule like "at least 2 admins per account,"
      and why.

---

## 7 · Cause and then prevent a deadlock  *(Lesson 06, 30 min)*

Run the `deadlock` scenario. Then write the two transactions so the same work happens with no
deadlock possible, and demonstrate it.

**Acceptance criteria**
- [ ] Transcript of the deadlock, including the `40P01` and which session was the victim.
- [ ] The wait edge captured from Tab 5 while both were blocked.
- [ ] A rewritten pair of transactions that cannot deadlock, demonstrated.
- [ ] The **lock-ordering rule** stated generally enough to apply to code you have not seen.

---

## 8 · Kill the N+1, then measure what you traded  *(Lesson 07, 40 min)*

Add a **playlists** feature to the lab database: a playlist has a name and an ordered list of
tracks. Write a query that returns one playlist with all its tracks, artists and albums.

Then implement it twice — N+1 and single-query — and measure both.

**Acceptance criteria**
- [ ] Schema for playlists with correct constraints (ordering, no duplicate positions, FKs).
- [ ] Both implementations return identical data.
- [ ] Query counts and block counts for both.
- [ ] The indexes you added, with justification from the worksheet.
- [ ] A sentence on which you would ship and what you gave up.

> This is the storage counterpart of the API course's playlists exercise. If you did that one, the
> two artifacts together — the contract and the storage behind it — are a strong portfolio piece.

---

## 9 · Size a pool from measurements  *(Lesson 07, 30 min)*

Using Tab 7, find the concurrency at which queue wait time starts to dominate for this lab's pool
of 8. Then predict — before running it — what happens at double that concurrency, and check.

**Acceptance criteria**
- [ ] A small table of concurrency vs total time vs p95 queue wait.
- [ ] Your prediction, recorded before the run that tests it.
- [ ] The formula relating pool size, concurrency and duration, stated and checked against your
      numbers.
- [ ] An explanation of why raising the pool size is not automatically the fix.

---

## 10 · Bloat a table, then find it  *(Lesson 08, 35 min)*

Update the same 10,000 rows in `plays` repeatedly. Watch dead tuples accumulate and the table grow
on disk. Then reclaim the space.

Useful:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables;
SELECT pg_size_pretty(pg_total_relation_size('plays'));
```

**Acceptance criteria**
- [ ] Dead-tuple count and table size recorded before, during and after.
- [ ] You can explain why plain `VACUUM` did not shrink the file.
- [ ] You demonstrated that an open transaction in another session prevents cleanup.
- [ ] You can state the setting you would change on a heavy-update table, and its default.

---

## 11 · The course artifact  *(Lesson 09, 90 min)*

Write the storage decision record described at the end of Lesson 09, for a real project.

**Acceptance criteria**
- [ ] Access patterns are concrete: volumes, latency budgets, predicate columns.
- [ ] "One Postgres node, indexed properly" appears among the options considered.
- [ ] At least three numbers come from your own measurements.
- [ ] The trade you are accepting is named explicitly.
- [ ] There is a "what would change my mind" section with a specific threshold.
- [ ] Someone else could act on this document without asking you a question.
