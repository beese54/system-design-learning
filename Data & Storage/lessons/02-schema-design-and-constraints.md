# 02 · Schema design and the constraints that outlive your code

Your application code is temporary. It gets rewritten in a new framework, ported to a new
language, replaced by a service, called from a script somebody wrote at 2am. The schema is what
survives all of that, which is why a rule enforced in the schema is worth more than the same rule
enforced in a validator.

This lesson is about writing down what is true, in the one place where it stays true.

---

## The relational model in one paragraph

A table is a set of rows with the same shape. A row is a fact. A key identifies a row. A foreign
key says "this fact refers to that fact." That is the entire model, and its power comes from what
it *refuses* to let you express: no ordering you did not ask for, no duplicates you did not
declare, no dangling references. Everything else — joins, indexes, transactions — is machinery
for making that model fast and safe.

The catalogue in this lab is four facts:

```
artists    one row per artist
albums     one row per album, referring to an artist
tracks     one row per track, referring to an album
plays      one row per time somebody played a track
listeners  one row per listener
```

Open **Tab 1 · Schema** in the lab. Everything shown there is queried live from
`information_schema.columns` and `pg_constraint` — Postgres' own catalogue — rather than parsed
out of the `.sql` file. That is deliberate. A schema diagram in a wiki starts drifting from
reality the day after somebody runs a migration. The catalogue cannot drift, because it *is* the
schema.

---

## Normalisation, without the vocabulary

You will meet "third normal form" and a list of numbered rules. The useful version is one
question:

> **Is this fact stored in exactly one place?**

If an artist's country is stored on the artist row, changing it is one update. If it is also
copied onto every album for convenience, changing it is one update plus a migration plus the rows
somebody missed — and now two places disagree and neither is obviously wrong. That disagreement
is called an *update anomaly*, and avoiding it is what normalisation is for.

The counter-pressure is real: normalised data needs joins, and joins cost. **Denormalise when you
have measured a join you cannot afford**, not when you anticipate one. Denormalisation is an
optimisation, and like every optimisation it is a debt you take on deliberately, with a note
saying what invariant you are now responsible for maintaining by hand.

A useful tell: if you cannot say which copy is authoritative, you have not denormalised — you
have introduced a bug that has not fired yet.

---

## Constraints are the part you cannot get back

Look at the constraint table in Tab 1. Every line there is a rule Postgres enforces on every
write, from every client, forever:

```sql
CHECK (year BETWEEN 1900 AND 2100)          -- no album released in 12024
UNIQUE (album_id, position)                 -- no two tracks in slot 3
REFERENCES artists(id) ON DELETE CASCADE    -- no album belonging to a deleted artist
NOT NULL                                    -- this fact is required to be a fact
```

The argument against constraints is always the same: "we validate that in the application."
Three answers:

1. **You validate it in *an* application.** The next one, the admin script, the data fix, and the
   analytics job that writes back all bypass your validator.
2. **Your validator races.** Two requests both check "is this position free?", both see yes, both
   insert. A `UNIQUE` constraint is the only thing that can lose that race safely — it is checked
   at write time by the thing doing the writing. You will watch exactly this race in Lesson 05.
3. **A constraint is documentation that cannot be wrong.** A new engineer reading
   `UNIQUE (album_id, position)` learns something true. A comment might be stale.

The cost is honest and worth stating: constraints make some migrations harder, and a `CHECK` you
regret is a lock-taking `ALTER TABLE` away from being removed. That is the trade. Take it — the
constraint you can drop later is cheaper than the corrupt data you cannot un-corrupt.

### The one Postgres does not do for you

Read the constraint list in Tab 1 again and notice what is *missing*: there is no index on
`albums.artist_id` or `tracks.album_id`.

**Postgres creates indexes for `PRIMARY KEY` and `UNIQUE`. It never creates one for a foreign
key.** Not on the referencing side, which is the side you query. This surprises almost everyone,
and it is one of the most common causes of a database that was fine at 10,000 rows and is not
fine at 10 million — because "show me this artist's albums" is a sequential scan, and so is every
`ON DELETE CASCADE`.

Lesson 04 has you fix it and measure what it was costing.

---

## Choosing types like they matter

They do. A type is a constraint that also determines storage size:

| Instead of | Use | Why |
|---|---|---|
| `varchar(255)` | `text` | In Postgres they are the same speed. The 255 is a folk memory from another database, and it will be wrong eventually. |
| `float` for money | `numeric` | Binary floats cannot represent 0.10. Do not find this out from an accountant. |
| `timestamp` | `timestamptz` | Stores an instant rather than an ambiguous wall-clock reading. The one you want is almost always this one. |
| `text` for enums | `text` + `CHECK`, or an enum type | `plays.device` in this schema is `CHECK (device IN (...))` — typos become errors instead of a fifth device nobody notices for a year. |
| `serial` | `bigint` / `bigserial` | An `int` primary key runs out at 2.1 billion. Migrating a live table's key type is a genuinely bad week. |

`plays.id` in this lab is `bigserial` for exactly that reason. A million rows today, and the
column costs four extra bytes to never think about it again.

---

## Design the schema around the questions

The API course told you to shape endpoints around what clients need to accomplish, not around
your tables. The storage version of that rule points the other way:

> **Shape tables around the facts. Shape *indexes* around the questions.**

Keep the schema normalised and honest, then let Lesson 04's indexes serve the specific access
patterns. This split matters because facts change rarely and questions change constantly. A
schema built around today's screen has to be migrated when the screen changes; a schema built
around the facts just needs another index.

---

## What you should now be able to do

- [ ] State the one question normalisation is really asking, and when to deliberately break it.
- [ ] Give three reasons a constraint beats the equivalent check in application code.
- [ ] Explain why `UNIQUE` is the only safe answer to a check-then-insert race.
- [ ] Say which indexes Postgres creates for you and which it does not.
- [ ] Justify `text`, `numeric`, `timestamptz` and `bigint` over their common alternatives.

**Artifact for this module:** design the schema for something you understand well that is *not*
this catalogue — a booking system, an invoice ledger, a permissions model, whatever you have real
knowledge of. Write the DDL. Then, beneath each table, write one line per constraint saying **what
would go wrong without it**. If you cannot name the failure, either the constraint is not earning
its place or you have not understood the domain yet — both are useful things to discover on paper.

Next: [03 · How a query actually runs](03-how-a-query-actually-runs.md)
