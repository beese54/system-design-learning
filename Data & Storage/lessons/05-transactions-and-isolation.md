# 05 · Transactions and isolation

This is the lesson a book cannot teach you, and the reason this course has a lab.

An isolation anomaly is not a fact you can memorise. It is a *story about interleaving*: session
A does this, session B does that, then A does one more thing and gets an answer that no single
statement could ever have produced. You have to watch it happen, in order, twice — once where it
breaks and once where it does not.

Open **Tab 4 · Transactions**. Sessions A and B on that page are two real Postgres backends with
their own PIDs. Nothing is simulated.

---

## ACID, briefly, then the hard part

**Atomicity** — all of it or none of it. **Consistency** — constraints hold at commit.
**Durability** — a committed write survives a crash. Those three are mostly free; the database
does them and you rarely think about them.

**Isolation** is the one you pay for, and the only one with a dial. It asks: when transactions
run concurrently, how much of each other's mess are they allowed to see? Turn the dial up and you
get correctness; turn it up and you also get contention, aborted transactions and retry logic.
Every real system picks a point on that dial, usually by accident.

Postgres' default is `READ COMMITTED`. If nobody on your team has chosen otherwise, that is what
you are running.

---

## Run the scenarios in this order

Each one uses **the identical script** at every isolation level. Only the level changes — that is
what makes the comparison mean anything.

### 1. The dirty read that cannot happen

Run `dirty-read` at `READ UNCOMMITTED`. A modifies a row without committing; B reads it and sees
the *old* value.

Postgres accepts the `READ UNCOMMITTED` syntax and quietly gives you `READ COMMITTED` instead. Its
storage engine keeps old row versions rather than modifying rows in place, so there is no way to
show you an uncommitted one. **You can stop worrying about dirty reads in Postgres.** Worth seeing
once so the worry is gone for good.

### 2. Non-repeatable read

Run `non-repeatable-read` at `READ COMMITTED`:

```
A: first read  → seconds = 210
B: update to 999, commit
A: second read → seconds = 999      ← inside one transaction
```

A asked the same question twice in one transaction and got two answers. At `READ COMMITTED` every
*statement* gets a fresh snapshot, so this is working as designed.

Now switch to `REPEATABLE READ` and run the identical script:

```
A: first read  → 210
A: second read → 210      ← B's commit is invisible to A
```

One snapshot for the whole *transaction*. This is the entire difference between the two levels.

### 3. Phantoms

Run `phantom` at `READ COMMITTED`: A counts featured albums (2), B inserts another and commits, A
counts again (3). A row appeared from nowhere.

At `REPEATABLE READ` both counts return 2. Note this is **stronger than the SQL standard
requires** — the standard permits phantoms at repeatable read, and many databases do. Postgres'
snapshot covers ranges as well as rows, so it does not. Portable code should not rely on this;
your code running on Postgres can.

### 4. The lost update — the one your code probably has

Run `lost-update` at `READ COMMITTED`:

```
A reads counter  → 0
B reads counter  → 0
A writes 1, commits
B writes 1, commits
final value = 1        ← two increments, one result
```

Nothing errored. No constraint was violated. One user's work silently disappeared. This is the
read-modify-write race, and it is in more application code than any other bug in this course —
every `SELECT` into a variable, modify in application code, `UPDATE` back is this shape.

At `REPEATABLE READ` the same script raises **40001**, and B must retry.

The important point: **a higher isolation level is not the fix here — it is the alarm.** The fix
is to stop splitting the read and the write:

```sql
UPDATE editorial_rules SET min_value = min_value + 1 WHERE rule = 'min_featured_albums';
```

One atomic statement. Correct at every isolation level, no retry needed. Or take the row lock
explicitly with `SELECT ... FOR UPDATE` (Lesson 06). Reach for isolation levels when you cannot
express the change as one statement.

### 5. Write skew — the one only SERIALIZABLE catches

This is the scenario worth the whole lesson. Run `write-skew` at `READ COMMITTED`:

```
Rule: at least one album must stay featured. Two are featured.

A: count featured → 2. Removing one is safe.
B: count featured → 2. Removing one is safe.
A: un-feature b1, commit
B: un-feature b2, commit

featured albums = 0        ← the rule is broken
```

Read that again, because it is genuinely unsettling. **Neither transaction did anything wrong.**
Each checked the invariant and each was correct when it checked. They touched *different rows*, so
no lock was ever contended and nothing blocked. `REPEATABLE READ` does not help either — neither
transaction read anything the other wrote, so there is no conflict for snapshot isolation to
detect.

Now run the identical script at `SERIALIZABLE`:

```
B: COMMIT → ERROR 40001: could not serialize access due to read/write dependencies
featured albums = 1        ← the rule held
```

`SERIALIZABLE` in Postgres tracks the *dependencies between reads and writes*, not just the
writes. It notices that A read a set that B wrote and vice versa, and that no serial ordering of
the two produces this outcome — so it aborts one.

**Write skew is the anomaly to remember**, because it is the one your instincts do not catch. Any
time a transaction reads something to decide whether a write is allowed — inventory, seat
availability, balance checks, "is this the last admin?" — you are exposed to it, and no amount of
careful single-transaction reasoning will find it.

---

## Choosing a level

| Level | Prevents | Still allows | Cost |
|---|---|---|---|
| `READ COMMITTED` | dirty reads | non-repeatable reads, phantoms, lost updates, write skew | cheapest; Postgres default |
| `REPEATABLE READ` | + non-repeatable reads, phantoms *(in Postgres)* | lost updates across statements, write skew | 40001 on conflicting updates |
| `SERIALIZABLE` | everything above, including write skew | — | tracks predicate dependencies; more 40001s under contention |

Practical guidance:

- Stay on `READ COMMITTED` for most work, and fix races with atomic statements, `FOR UPDATE`, and
  unique constraints.
- Use `SERIALIZABLE` for the handful of transactions with a **read-to-decide-then-write** shape.
  You can mix levels per transaction; it does not have to be a global setting.
- Never use a longer transaction as a substitute for the right level. It just holds locks longer.

---

## 40001 is not a failure

The most common mistake after adopting `SERIALIZABLE` is treating serialization errors as bugs.
They are not. **A 40001 is the database telling you it refused to corrupt your data.** The bug is
not having a retry loop:

```js
async function withRetry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (e.code !== '40001' && e.code !== '40P01') throw e;  // not retryable
      await sleep(2 ** i * 50 + Math.random() * 50);          // back off, jitter
    }
  }
  throw new Error('exhausted retries');
}
```

Three rules: retry the **whole transaction** from the beginning (its snapshot is gone — replaying
one statement is meaningless), back off with jitter so competing transactions do not collide
again, and cap the attempts. And keep serializable transactions short: the longer they run, the
more they conflict with, and the more retries you generate.

---

## What you should now be able to do

- [ ] Explain why Postgres has no dirty reads at any isolation level.
- [ ] Describe the difference between a statement snapshot and a transaction snapshot.
- [ ] Recognise the read-modify-write shape in code, and fix it without changing isolation level.
- [ ] Explain write skew to someone else, including why row locking cannot catch it.
- [ ] Choose an isolation level per transaction and defend the choice.
- [ ] Write a correct retry loop, and say why it must retry the whole transaction.

**Artifact for this module:** find a **read-to-decide-then-write** transaction in a real system —
yours, or one you can describe precisely. Write up: the invariant it assumes, the interleaving that
breaks it (concretely — A does this, B does that), and the fix you would ship, choosing between an
atomic statement, an explicit lock, a constraint, and `SERIALIZABLE` plus retry. Then reproduce
your interleaving in this lab to prove the anomaly is real and your fix works. **That reproduction
is the artifact.** An argument that an anomaly is possible is a hypothesis; a lab transcript is
evidence.

Next: [06 · Concurrency and locking](06-concurrency-and-locking.md)
