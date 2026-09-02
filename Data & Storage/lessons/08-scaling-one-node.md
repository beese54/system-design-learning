# 08 · Scaling one node

Before you shard, before you add read replicas, before you move to something with "distributed"
in its marketing: one Postgres node on decent hardware handles far more than most teams assume.
Tens of thousands of transactions per second, tables in the hundreds of millions of rows. Most
systems that "outgrew Postgres" outgrew an unindexed query, a bloated table, or a pool of 200
connections fighting over eight cores.

This lesson covers what you do to one node before distributing anything — and the maintenance
that MVCC quietly requires.

---

## Dead rows, bloat, and why VACUUM exists

From Lesson 06: an `UPDATE` writes a new row version and marks the old one dead. A `DELETE` just
marks it dead. Nothing is reclaimed immediately, because some older transaction might still need
to see it.

So every update and delete leaves litter. **VACUUM** is the cleaner. It:

- marks dead row space reusable (plain `VACUUM`) — it does *not* return disk to the OS,
- updates the **visibility map**, which is what makes Index Only Scans possible,
- refreshes planner statistics (`ANALYZE`),
- advances the transaction-ID freeze horizon.

Autovacuum runs this for you. It is usually fine, and the two ways it stops being fine are worth
knowing:

**Bloat.** A table where dead rows accumulate faster than autovacuum clears them grows on disk
while holding the same live data. Sequential scans get slower in proportion to the *physical* size,
not the useful size. Heavy-update tables need more aggressive settings than the defaults:

```sql
ALTER TABLE plays SET (autovacuum_vacuum_scale_factor = 0.02);  -- default 0.2
```

The default only triggers a vacuum after 20% of the table is dead, which on a large table is an
enormous amount of garbage.

**Blocked cleanup.** VACUUM can only remove versions older than the **oldest running snapshot**.
One long-running transaction — or one `idle in transaction` session from Lesson 06 — pins that
horizon and stops cleanup *across the whole database*. This is the mechanism by which a forgotten
`BEGIN` in one service bloats tables it never touched.

```sql
SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;
SELECT max(age(backend_xmin)) FROM pg_stat_activity;   -- how far behind the oldest snapshot is
```

To actually return disk to the OS you need `VACUUM FULL` (rewrites the table, takes `ACCESS
EXCLUSIVE`, an outage on a big table) or `pg_repack` (does it without the exclusive lock — use
this one).

---

## Partitioning

The `plays` table in this lab grows forever. Time-series data always does. Partitioning splits it
into child tables under one parent:

```sql
CREATE TABLE plays (...) PARTITION BY RANGE (played_at);
CREATE TABLE plays_2026_09 PARTITION OF plays
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

What it actually buys:

- **Partition pruning.** A query with `WHERE played_at > now() - interval '7 days'` reads one or
  two partitions instead of all of them. The planner does this at plan time.
- **Cheap deletion.** `DROP TABLE plays_2024_01` removes a month instantly. `DELETE FROM plays
  WHERE played_at < ...` on a large table is slow, produces enormous bloat, and forces a vacuum.
  **This is usually the real reason to partition.**
- **Smaller indexes.** Per-partition indexes on a working set that fits in memory.

What it does not buy: it is not a substitute for indexing, and it does not help queries that have
no predicate on the partition key. A query filtering only on `track_id` still touches every
partition — and now pays planning overhead for each.

Rules: partition on the column your queries filter and your retention policy deletes by (almost
always time); keep partitions in the dozens-to-low-hundreds; automate creation ahead of time,
because a missing partition is a failed insert at midnight.

---

## Configuration that actually matters

Most Postgres tuning advice is noise. These four are not:

| Setting | Rough starting point | Why |
|---|---|---|
| `shared_buffers` | 25% of RAM | Postgres' own block cache. The rest of RAM is still used by the OS page cache, which is why 25% rather than 80%. |
| `work_mem` | 4–64 MB | Memory **per sort or hash node, per query**. Too low sends sorts to disk (`external merge` in your plans); too high times concurrency equals an OOM. |
| `effective_cache_size` | 50–75% of RAM | Not an allocation — a *hint* about how much caching exists. Too low makes the planner distrust indexes. |
| `max_connections` | low; use a pool | Each one is a process. See Lesson 07. |

`work_mem` is the one worth watching in plans. When you see `Sort Method: external merge Disk:
48MB`, that sort spilled — raising `work_mem` for that query (you can `SET` it per transaction)
turns it into `quicksort Memory`.

Set `log_min_duration_statement` to something like `500ms` in production. Logging every slow query
costs almost nothing and is the highest-value observability change available. This lab sets it to
`0` — log everything — which is deliberately excessive and useful for learning: run
`docker compose logs -f db` while clicking around the lab and watch every statement appear with
its duration.

---

## Read replicas

Streaming replication ships the write-ahead log to a standby, which replays it. The standby can
serve reads.

This is the first genuinely distributed thing in this lesson, and it comes with the trade-off
Lesson 01 promised: **replication lag**. A replica is behind the primary by anywhere from
milliseconds to minutes. Write a row, immediately read it from a replica, and it may not be there.

The failure mode is always the same: user submits a form, is redirected to a page that reads from
a replica, and their change has vanished. Fixes:

- Route reads that must be current back to the primary — "read your own writes."
- Use `pg_current_wal_lsn()` / `pg_last_wal_replay_lsn()` to wait for a replica to catch up to a
  specific position when it matters.
- Accept staleness where it genuinely does not matter (analytics, reports, search indexes) — which
  is most read traffic, and why replicas work at all.

Replicas scale reads. **They do nothing for write throughput** — every replica replays every write.

---

## Sharding, and why it is last

Splitting data across independent databases by key. It is the only thing that scales writes
horizontally, and it is a large one-way door:

- Cross-shard joins and transactions get hard or impossible.
- Rebalancing is a project.
- Every query needs the shard key, or it fans out to all shards.
- Your operational surface multiplies.

Do all of this first, in order: fix the queries and indexes, size the pool, deal with bloat,
partition the big table, move heavy reads to replicas, buy a bigger machine (this is genuinely
underrated — vertical scaling is cheap compared to an engineer-year), archive cold data. Only then
shard.

The systems that shard successfully usually have a natural boundary already — per-tenant, per-
region — where cross-shard queries are rare by construction. If you do not have one, you are
choosing to build a distributed database by hand.

---

## What you should now be able to do

- [ ] Explain why MVCC makes VACUUM necessary, and what plain VACUUM does and does not reclaim.
- [ ] Describe how one long transaction bloats tables it never touched.
- [ ] Say what partitioning buys, and name the case where it is mainly about deletion.
- [ ] Explain `shared_buffers`, `work_mem` and `effective_cache_size` and the failure mode of each.
- [ ] Recognise a spilled sort in a plan and fix it.
- [ ] Explain read-your-own-writes and how replication lag breaks it.
- [ ] Give the ordered list of things to do before sharding.

**Artifact for this module:** a **maintenance and growth plan** for one real table. Include:
current size and growth rate, whether it is update-heavy and therefore bloat-prone, its retention
policy (and whether that is currently enforced by anything), whether it should be partitioned and
on what key, and the three settings you would check first if it became slow. If the retention
policy is "we have never deleted anything," write that down — it is the finding.

Next: [09 · When relational is the wrong answer](09-when-relational-is-wrong.md)
