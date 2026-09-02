# Schema Design Canvas

Fill this in for a system you actually work on, before writing any DDL. One canvas per bounded
area — if you cannot fit it on a page, you are designing two things at once.

---

## 1. The facts

What does this system need to remember? One line per fact, in plain language, no table names yet.

| # | Fact | Who creates it | How often it changes |
|---|------|----------------|----------------------|
| 1 |      |                |                      |
| 2 |      |                |                      |
| 3 |      |                |                      |

> Facts that never change after creation (events, log entries, plays) behave completely differently
> from facts that change constantly (balances, statuses, counters). Mark which is which — it drives
> bloat, partitioning and locking decisions later.

---

## 2. The entities and their keys

| Entity | Natural key (if any) | Chosen primary key | Why |
|--------|----------------------|--------------------|-----|
|        |                      |                    |     |

> If you chose a surrogate key, say what the natural key would have been and why you rejected it.
> "There isn't one" is a legitimate and common answer — write it down.

---

## 3. Relationships

| From | To | Cardinality | On delete | Is the FK column indexed? |
|------|----|-------------|-----------|---------------------------|
|      |    | 1:N / N:M   | CASCADE / RESTRICT / SET NULL | ☐ |

> Postgres does not index foreign keys for you. The last column is not rhetorical — an unindexed
> FK makes both "children of X" and `ON DELETE CASCADE` a sequential scan.

---

## 4. Invariants

Rules that must be true no matter which application, script or human is writing.

| Invariant | Enforced by | What goes wrong without it |
|-----------|-------------|----------------------------|
|           | CHECK / UNIQUE / FK / NOT NULL / app code / nothing | |

> Any row where "enforced by" is *app code* or *nothing* is a bet. Some bets are fine. Write down
> what you are betting. If you cannot name the failure in column three, the constraint may not be
> earning its place — or you do not understand the domain yet.

---

## 5. Types

| Column | Type chosen | Rejected alternative | Why |
|--------|-------------|----------------------|-----|
|        |             |                      |     |

> Cover at least: every money column, every timestamp, every identifier, and every column with a
> fixed set of allowed values.

---

## 6. Growth

| Table | Rows today | Rows in 12 months | Update-heavy? | Retention policy |
|-------|-----------|-------------------|---------------|------------------|
|       |           |                   | yes / no      | (or "none, and nobody has decided") |

> The largest table and the most-updated table are usually different tables, and they need
> different attention: one gets partitioned, the other gets vacuum tuning.

---

## 7. The questions this schema must answer

Not the tables — the queries. These drive indexes, not schema.

| # | Question | Expected frequency | Latency budget | Predicate columns |
|---|----------|--------------------|----------------|-------------------|
| 1 |          |                    |                |                   |

> The last column is your index shortlist. Equality columns first, range columns last.

---

## 8. What I am deliberately not doing

Denormalisations, missing constraints, deferred decisions — with the reason and the trigger that
would make you revisit.

| Decision | Reason | What would change my mind |
|----------|--------|---------------------------|
|          |        |                           |
