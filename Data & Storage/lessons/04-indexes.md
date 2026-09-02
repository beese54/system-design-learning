# 04 · Indexes

An index is a deal. You agree to pay on every write, forever, and in exchange some reads get
dramatically cheaper. The deal is usually good. It is not always good, and nobody sends you an
invoice for the part you are paying — which is why databases accumulate indexes that cost real
money and serve nothing.

This lesson is about reading the deal before you sign it.

---

## What a B-tree actually is

Postgres' default index is a B-tree: a shallow, sorted, block-structured tree. For a million-row
table it is about three or four levels deep, so finding any value costs three or four block
reads instead of 36,372.

Two consequences follow from "sorted", and they explain nearly everything an index can and cannot
do:

**It can serve ordering, not just matching.** `ORDER BY played_at DESC LIMIT 10` can walk the tail
of an index on `played_at` and stop after ten rows. No sort, no scan.

**It can serve prefixes, not suffixes.** The index is sorted by its first column, then by its
second within that. Like a phone book sorted by (surname, first name): finding everyone called
Kim is instant, finding everyone whose first name is Nova means reading the whole thing. This is
the single most important fact about composite indexes, and Lab 3 has a pair of them that prove
it.

---

## Run the loop

Open **Tab 3 · Indexes**. The loop is: *probe → create → probe again → check the write cost.*
Start with `plays (track_id)`. Real numbers from this lab:

```
                     before              after
time                 20.2 ms             1.25 ms         16× faster
blocks               36,372              10              3,637× fewer
access               Seq Scan            Index Only Scan
index build          —                   335 ms, 7.1 MB
```

Two things to notice beyond the speed-up.

**It became an *Index Only* Scan.** The query was `count(*) ... WHERE track_id = 't5'` — it needed
no column other than `track_id`, and the index holds `track_id`. The table was never touched at
all. That is the cheapest read Postgres can do.

**The blocks improved far more than the time.** 3,637× fewer blocks but only 16× faster, because
this table fits in the page cache — the sequential scan was reading from RAM, not disk. On a
table larger than memory that 16× becomes hundreds. **This is why block counts are the honest
metric and milliseconds are the flattering one.**

---

## Column order in composite indexes

The lab ships two indexes over the same two columns, deliberately:

```sql
CREATE INDEX idx_plays_track_time ON plays (track_id, played_at);   -- right
CREATE INDEX idx_plays_time_track ON plays (played_at, track_id);   -- wrong
```

For the query `WHERE track_id = 't5' AND played_at > now() - interval '30 days'`:

- **`(track_id, played_at)`** — seek to `t5`, then walk forward through that track's plays in time
  order and stop at the boundary. Both predicates served by one seek.
- **`(played_at, track_id)`** — the leading column is the *range*. Postgres must scan every row in
  the 30-day window and check `track_id` on each. The second column filters; it does not seek.

**The rule: equality columns first, range columns last.** Same two columns, same disk cost, very
different query — and in a code review the two lines look identical. Create them both in the lab
and probe the same query against each.

One corollary worth internalising: `(track_id, played_at)` also serves any query that filters on
`track_id` alone. A composite index covers its own prefixes, so `idx_plays_track` becomes
redundant the moment `idx_plays_track_time` exists. Redundant indexes are pure cost.

---

## When an index cannot help

**You wrapped the column in a function.** Try *"A function call that disables an index"* in Tab 2:

```sql
SELECT count(*) FROM listeners WHERE lower(handle) = 'listener_42';
```

`handle` has a unique index. It is not usable, because the index stores `handle`, not
`lower(handle)`. Two fixes: rewrite the predicate to touch the bare column, or build an
expression index — `CREATE INDEX ON listeners (lower(handle))` — which stores the computed value.
The second only works for queries spelling the expression *exactly* the same way.

**A leading wildcard.** `LIKE '%kim'` cannot use a B-tree; `LIKE 'kim%'` can. Same reason as the
phone book.

**The value is not selective enough to be worth it.** This one is subtler than the usual advice
admits, and the lab will correct you if you take the folklore at face value.

Create `plays (device)` in Tab 3. Four distinct values across a million rows, so `device = 'phone'`
matches about 250,000 — a quarter of the table. The folklore says the planner will ignore an index
that unselective. Measure it:

```sql
SELECT avg(ms_played) FROM plays WHERE device = 'phone';
  without index   30.5 ms    Parallel Seq Scan
  with index      27.2 ms    Parallel Bitmap Heap Scan   ← used, and barely better
```

The planner *did* use it. It just did not help much, because the query still has to visit the heap
for `ms_played`, and 250,000 heap visits is most of the work either way. **~10% faster, for 7 MB
and a permanent share of every write.** That is the real lesson: not that unselective indexes are
rejected, but that they are *marginal* — they look reasonable in review and quietly are not worth
it.

Now change one thing and run it again:

```sql
SELECT count(*) FROM plays WHERE device = 'phone';
  without index  125 ms    Parallel Seq Scan
  with index      12 ms    Parallel Index Only Scan     ← 10× faster
```

Same index, same selectivity, tenfold win — because `count(*)` needs no column outside the index,
so the heap is never touched. A 250,000-row index-only scan beats a million-row heap scan easily.

So the honest rule is not about selectivity alone:

> An index wins when it lets you **avoid work**. High selectivity avoids work by matching few rows.
> Covering the query avoids work by skipping the heap. An unselective index that still requires a
> heap visit per row avoids very little, whatever the plan says.

Rule of thumb for the common case — a query that needs columns outside the index — an index earns
its place at **well under 10%** selectivity. Above that, measure before you ship, and measure the
query you are actually going to run.

---

## The bill

Click **Time 20,000 inserts** in Tab 3, add four more indexes, click it again. From this lab:

```
2 indexes on plays    490 ms    24.5 µs/row
6 indexes on plays    639 ms    32.0 µs/row      +30%
```

Every index must be updated by every `INSERT`, every `DELETE`, and every `UPDATE` that touches an
indexed column. That 30% is permanent, it applies to your write path forever, and no dashboard
attributes it to the index that caused it.

So the question is never "would an index make this query faster?" — it nearly always would. The
question is **"is this query worth 6% of my write throughput?"** Sometimes emphatically yes.
Sometimes it is a query that runs twice a month in a report nobody reads.

### Finding the ones already costing you

The index table at the bottom of Tab 3 shows a **scans** column straight from
`pg_stat_user_indexes`. Zero scans on a non-unique index means: never used since the server
started, still updated on every write. In production that query is the highest-value thing in this
lesson:

```sql
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
  FROM pg_stat_user_indexes WHERE idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC;
```

Check uptime before you drop anything — an index used only by month-end reporting looks unused on
day three.

---

## Building without stopping the world

`CREATE INDEX` takes a lock that blocks writes for the whole build. On a large production table
that is an outage.

```sql
CREATE INDEX CONCURRENTLY idx_plays_track ON plays (track_id);
```

Slower, two table passes, cannot run inside a transaction — and does not block writers. Use it in
production, always. It can fail and leave an `INVALID` index behind, so check
`pg_index.indisvalid` afterwards, drop the invalid one, and retry.

---

## What you should now be able to do

- [ ] Explain why a B-tree serves prefixes and ordering but not suffixes.
- [ ] Order the columns of a composite index correctly, and justify it.
- [ ] Name four reasons an existing index goes unused, and fix each.
- [ ] State roughly how selective a predicate must be for an index to win.
- [ ] Quantify the write cost of an index rather than assuming it is negligible.
- [ ] Find unused indexes on a live database, and say why uptime matters before dropping them.
- [ ] Say why you would never run a bare `CREATE INDEX` in production.

**Artifact for this module:** take one real query — from your system, or the artist page in Tab 6
— and produce a **before/after index record**: the two plans, the two block counts, the index
size, the measured write cost, and a short paragraph on why you would or would not ship it. The
paragraph must argue *both* sides. An artifact that only shows the speed-up is a sales pitch, not
an engineering decision.

Next: [05 · Transactions and isolation](05-transactions-and-isolation.md)
