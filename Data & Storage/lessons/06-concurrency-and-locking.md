# 06 · Concurrency and locking

Lesson 05 was about what transactions *see*. This one is about what they make each other *wait
for* — and about the single most common shape of a database incident, which is not a slow query
at all but a queue behind a lock.

---

## Readers do not block writers

Start here, because it is the fact that makes Postgres pleasant and the fact that misleads people
into thinking locks are not their problem.

Postgres uses MVCC — multi-version concurrency control. An `UPDATE` does not overwrite a row; it
writes a **new version** of it and marks the old one as dead. Readers holding an older snapshot
keep reading the old version quite happily.

The consequence:

- Readers never block readers.
- Readers never block writers.
- Writers never block readers.
- **Writers block writers, on the same row.**

Only that last line can make your application wait. Everything in this lesson lives inside it —
plus the price of all those old row versions, which is Lesson 08.

---

## Row locks, taken deliberately

Lesson 05's lost update happened because a read and a write were separated in time. `SELECT ...
FOR UPDATE` closes the gap by locking the rows as you read them:

```sql
BEGIN;
SELECT min_value FROM editorial_rules WHERE rule = 'min_featured_albums' FOR UPDATE;
-- any other transaction asking for this row now waits here
UPDATE editorial_rules SET min_value = min_value + 1 WHERE rule = 'min_featured_albums';
COMMIT;   -- lock released
```

Run the `lock-wait` scenario in Tab 4. Step 2 goes yellow and says **blocked** — B is not
erroring, not being aborted, just stopped. It stays stopped until A commits, at which point B's
statement completes and returns the *new* value. Final counter: 2. Both increments survived.

The variants are worth knowing:

| Clause | Behaviour |
|---|---|
| `FOR UPDATE` | Exclusive. Others wait. |
| `FOR NO KEY UPDATE` | Weaker; allows concurrent foreign-key checks. What a plain `UPDATE` takes. |
| `FOR SHARE` | Several readers may hold it; writers wait. |
| `FOR UPDATE NOWAIT` | Fail immediately (55P03) instead of waiting. |
| `FOR UPDATE SKIP LOCKED` | Skip rows someone else holds. The correct way to build a work queue. |

`SKIP LOCKED` deserves the highlight. It is how you let N workers pull from one table without
coordination and without any two picking the same row:

```sql
UPDATE jobs SET status = 'running'
 WHERE id IN (SELECT id FROM jobs WHERE status = 'queued'
               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

---

## Deadlock

Run the `deadlock` scenario and watch it happen:

```
A: BEGIN, lock album b1
B: BEGIN, lock album b2
A: wants b2  → blocked (B holds it)
B: wants b1  → blocked (A holds it)

... 1 second later ...

ERROR 40P01: deadlock detected
```

Neither can proceed and neither will ever give up, so Postgres runs a cycle detector every
`deadlock_timeout` (1 second in this lab's compose file), picks a victim and aborts it. The
survivor continues.

**The cause is not too many locks. It is inconsistent lock ordering.** A took b1 then b2; B took
b2 then b1. Had both taken them in the same order, the second would simply have waited.

So the fix is a discipline, not a setting:

1. **Order your locks.** Pick a rule — ascending primary key is the usual one — and apply it
   everywhere. `ORDER BY id` on the `SELECT ... FOR UPDATE` that grabs multiple rows costs nothing
   and removes an entire class of incident.
2. **Take locks late and release them early.** Do the reads and the computation first; lock as
   close to the commit as you can.
3. **Keep transactions short.** A transaction that holds locks across an HTTP call to a payment
   provider will eventually hold them for the provider's timeout.
4. **Retry 40P01**, exactly like 40001 — same loop from Lesson 05. Deadlock is not a bug you can
   always design away; it is a condition you must survive.

Lowering `deadlock_timeout` does not reduce deadlocks. It only makes you find out sooner.

---

## Finding the blocker during an incident

**Tab 5 · Locks** runs the query worth memorising. Start the deadlock or `lock-wait` scenario,
stop on the blocking step, then open the tab:

```sql
SELECT w.pid AS waiting_pid, w.wait_event_type, w.wait_event,
       b.pid AS blocking_pid, left(b.query, 90) AS blocking_query,
       now() - w.query_start AS waited
  FROM pg_stat_activity w
  LEFT JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ON true
  LEFT JOIN pg_stat_activity b ON b.pid = bp.pid
 WHERE cardinality(pg_blocking_pids(w.pid)) > 0;
```

`pg_blocking_pids()` is the function to remember. During an incident it answers the only question
that matters — **who is at the head of the queue** — in one hop, instead of you reading
`pg_locks` and joining it to itself.

When you find the culprit: `SELECT pg_cancel_backend(pid)` cancels its current statement,
`pg_terminate_backend(pid)` kills the connection. Try cancel first.

---

## `idle in transaction`, the quiet killer

The other row that view surfaces. A session that ran `BEGIN`, did some work, and then went away —
waiting on an API call, blocked on application code, or attached to a developer who wandered off.

It holds every lock it has taken. It also **holds back the oldest snapshot**, which stops VACUUM
from cleaning up dead rows anywhere in the database (Lesson 08). One forgotten transaction can
bloat tables it never touched.

Set the guard and stop relying on discipline:

```sql
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';
```

The general principle behind all of this: **the damage a transaction does is measured by how long
it holds locks, not by how much work it does.** A transaction that updates one row and then waits
90 seconds on a third-party API is far more dangerous than one that updates 10,000 rows in 200 ms.
Never open a transaction across a network call to something you do not control.

---

## Table-level locks and migrations

Row locks are the ones you meet daily; table locks are the ones that cause outages. `ALTER TABLE`
generally takes `ACCESS EXCLUSIVE`, which blocks *everything*, including reads.

Modern Postgres has made many operations cheap — adding a nullable column, or a column with a
default, is metadata-only. Others still rewrite the whole table. Two rules that prevent most
migration incidents:

- **Always set a short `lock_timeout` before a migration.** Without it, your `ALTER TABLE` queues
  behind one long-running query, and every query arriving afterwards queues behind *your*
  `ACCESS EXCLUSIVE` request. A five-second-lock migration takes the site down for ten minutes.
  ```sql
  SET lock_timeout = '3s';
  ALTER TABLE plays ADD COLUMN source text;
  ```
  Failing fast and retrying is strictly better than blocking the world.
- **Add constraints in two steps.** `ADD CONSTRAINT ... NOT VALID` takes a brief lock and applies
  to new rows; `VALIDATE CONSTRAINT` then scans the existing rows without blocking writes.

---

## What you should now be able to do

- [ ] State which of the four reader/writer combinations can block, and why MVCC frees the others.
- [ ] Choose between `FOR UPDATE`, `NOWAIT` and `SKIP LOCKED`, and build a work queue with the last.
- [ ] Explain what actually causes deadlocks and give the structural fix.
- [ ] Find the blocking PID on a live database and decide between cancel and terminate.
- [ ] Explain how one `idle in transaction` session bloats tables it never touched.
- [ ] Say why every migration should set `lock_timeout` first.

**Artifact for this module:** cause a deadlock in the lab, capture the full transcript from both
sessions plus the wait edge from Tab 5. Then write the **lock-ordering rule** that would have
prevented it, stated precisely enough that another engineer could apply it — and find one place in
a real codebase where that rule is currently violated. The rule is the deliverable; the deadlock
is just proof you understand what you are ruling out.

Next: [07 · Connections, pooling, and the N+1 you already met](07-connections-and-n-plus-1.md)
