# Index Decision Worksheet

One sheet per index you are considering. The point of this worksheet is that it forces you to
write down the cost, which is the half nobody records.

---

**Index under consideration:** `CREATE INDEX ______ ON ______ (______);`

**Date / who:**

---

## 1. The query it is for

```sql

```

Frequency: ______ per second / minute / day
Latency budget: p95 under ______ ms
Is this on a user-facing path, or a background job?

---

## 2. Selectivity

| | |
|---|---|
| Rows in the table | |
| Rows this predicate matches (typical) | |
| Rows it matches (worst case) | |
| **Selectivity** (matched ÷ total) | ____ % |

> Under ~10% and an index is likely to win. Over ~25% and the planner will usually prefer a
> sequential scan — and will be right. Check the **worst case** row, not just the typical: an index
> that helps the median user and is ignored for your largest customer is a trap.

---

## 3. Measured before / after

Run the query, capture the plan, add the index, run it again. Block counts first — they are stable
across runs; milliseconds vary with cache warmth.

| | Before | After |
|---|--------|-------|
| Access method | | |
| Execution time | | |
| **Blocks read** | | |
| Rows removed by filter | | |

Index size: ______   Build time: ______

> If the "after" access method is still a Seq Scan, stop. The planner rejected your index and the
> rest of this worksheet is moot. Find out why: selectivity, a function wrapping the column, stale
> statistics, or wrong column order.

---

## 4. The write cost

| | |
|---|---|
| Indexes on this table before | |
| Write throughput before (rows/sec or ms per batch) | |
| Write throughput after | |
| **Change** | ____ % |

Which statements pay this? (every INSERT / DELETE / UPDATE touching the indexed columns)

---

## 5. Redundancy check

- [ ] Does an existing index already cover this as a **prefix**? (`(a, b)` serves queries on `a`)
- [ ] Does this index make an existing one redundant? If so, name it — and drop it.
- [ ] Could this be a **composite** that replaces two existing single-column indexes?
- [ ] Could this be **covering** (`INCLUDE`) and turn the query into an Index Only Scan?
- [ ] Could this be **partial** (`WHERE status = 'active'`) and be much smaller?

Existing indexes on this table:

```

```

---

## 6. Decision

☐ **Ship it** — the read win justifies the write cost, because:

☐ **Ship a different index instead** — namely:

☐ **Do not ship** — because:

**How it will be deployed:** `CREATE INDEX CONCURRENTLY` ☐ (required in production)

**When I will check whether it was worth it:** ______
**What I will look at:** `idx_scan` in `pg_stat_user_indexes`, and:

---

## 7. Argue the other side

Write two sentences arguing *against* your own decision. If you cannot, you have not understood
the trade — every index is a real cost paid forever, and every declined index is a real query left
slow.

>
