# Transaction Review Checklist

Run this over any code path that writes to the database. It is deliberately short — a checklist
you actually use beats a comprehensive one you skim.

**Transaction / code path under review:**

---

## 1. Shape

- [ ] I can state, in one sentence, what this transaction is atomic *about*.
- [ ] Everything inside the transaction needs to be inside it. (Reads that could happen before it,
      or work that could happen after, are lock time you are paying for nothing.)
- [ ] **There is no network call to anything I do not control inside this transaction.** No payment
      provider, no email service, no internal HTTP call. A third-party timeout must cost one
      request, not the connection pool.
- [ ] No user interaction, no waiting on a queue, no sleep.

## 2. The read-modify-write test

- [ ] Does this transaction **read a value, compute from it, and write it back?**

If yes, it is a lost-update candidate. Which fix applies?

- [ ] Rewrite as one atomic statement (`SET n = n + 1`, `INSERT ... ON CONFLICT DO UPDATE`)
- [ ] `SELECT ... FOR UPDATE` on the rows being decided about
- [ ] A `UNIQUE` constraint that makes the race impossible to lose silently
- [ ] `SERIALIZABLE` plus a retry loop

> Preference order is top to bottom. An atomic statement is correct at every isolation level and
> needs no retry logic.

## 3. The write-skew test

- [ ] Does this transaction **read something to decide whether a write is allowed?**
      (inventory levels, seat availability, "is at least one X remaining", balance checks,
      "is this the last admin")

If yes:

- [ ] I have identified the invariant it assumes, in writing:

      > ______________________________________________

- [ ] I have written down the interleaving that breaks it (A does…, B does…), concretely.
- [ ] The fix is: ☐ SERIALIZABLE + retry ☐ lock the *set* being decided over ☐ express the
      invariant as a constraint the database enforces
- [ ] **I have reproduced the anomaly in the lab**, or in a test, rather than reasoning about it.

## 4. Isolation

- [ ] The isolation level is a deliberate choice, not an inherited default.
- [ ] Level chosen: ______________ because: ______________
- [ ] If `REPEATABLE READ` or `SERIALIZABLE`: **there is a retry loop** that
  - [ ] retries the whole transaction from the start, not one statement
  - [ ] catches `40001` **and** `40P01`
  - [ ] backs off with jitter
  - [ ] has a maximum attempt count
  - [ ] does not retry anything that is not one of those two codes

## 5. Locking

- [ ] Rows locked in a **consistent order** with every other path that locks the same tables
      (`ORDER BY id` on multi-row `FOR UPDATE`).
- [ ] Locks are taken as late as possible.
- [ ] If this is a work queue: it uses `FOR UPDATE SKIP LOCKED`.
- [ ] I know roughly how long this transaction holds its locks under normal load.
- [ ] Worst case, under a slow query or contention, that duration is: ______

## 6. Failure

- [ ] Every error path either commits or rolls back — no path leaves the transaction open.
- [ ] The connection is returned to the pool on every path, including thrown exceptions.
- [ ] If this retries, the operation is **idempotent**, or protected by a unique key, so a retried
      transaction cannot double-apply.
- [ ] A partial failure leaves the database in a state the next request can handle.

## 7. Operational

- [ ] `idle_in_transaction_session_timeout` is set on this database.
- [ ] `statement_timeout` is set for this workload.
- [ ] If a migration touches these tables, it sets `lock_timeout` first.

---

## Findings

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | | | |
| 2 | | | |

**Verdict:** ☐ ship ☐ ship with the fixes above ☐ redesign — this transaction cannot be made
correct in its current shape
