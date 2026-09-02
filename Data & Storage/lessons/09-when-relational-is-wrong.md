# 09 · When relational is the wrong answer

Eight lessons of Postgres have earned this one a fair hearing. Relational databases are the right
default for most systems — the model is honest, the constraints are enforceable, the query
language answers questions nobody anticipated, and the operational knowledge is everywhere. But
"right default" is not "right always," and the failure mode of this course would be leaving you
unable to recognise the cases where something else fits better.

This lesson is the decision, and the decision record that closes the course.

---

## Start with the access pattern, not the technology

The question is never "SQL or NoSQL." It is:

> **What does this data need to do, and what am I willing to give up to make it do that?**

Every store below is a set of things given up in exchange for something. Name both halves and the
choice usually makes itself.

### Key-value (Redis, DynamoDB, Memcached)

Get and put by key, extremely fast. Gives up: querying by anything other than the key, joins, and
often durability guarantees.

Right for: sessions, caches, rate limiters, feature flags, leaderboards. Wrong for: anything you
will later want to query a different way — and you usually will.

The most common real use is a **cache in front of Postgres**, which is the next course in this
series. Note what a cache actually gives up: correctness at the edges. Invalidation is the hard
part, and a cache is a second copy of the truth that can disagree with the first.

### Document (MongoDB, DynamoDB, or Postgres `jsonb`)

Store a nested document, retrieve it whole. Gives up: enforced structure, and cheap querying
across documents.

Right for: genuinely schema-variable data — per-customer form definitions, event payloads from
sources you do not control, content with heterogeneous shapes. Wrong for: data with real relations,
which is most data. The "no schema" appeal usually means the schema moved into your application
code, unenforced, in several places at once.

**Important**: Postgres has `jsonb`, with indexing and rich operators. A `jsonb` column on a
relational table covers a large fraction of "we need document storage" — structured columns for the
fields you query and constrain, `jsonb` for the genuinely variable part. Reach for a separate
document database only when that stops working, not before.

### Columnar / analytical (ClickHouse, BigQuery, Snowflake, DuckDB)

Store by column rather than by row, so scanning one column across a billion rows reads only that
column. Gives up: efficient single-row reads and updates, and often transactions.

Right for: analytics — `SELECT device, count(*) FROM plays GROUP BY device` over a billion rows.
Wrong for: serving your application. This is the clearest case in the list, because it is a
genuinely different physical layout, and it is why "run analytics on a read replica" only works up
to a point. When your reporting queries are scanning the entire `plays` table, you do not need a
bigger Postgres; you need a column store fed from it.

### Search (Elasticsearch, OpenSearch, Postgres full-text)

Inverted indexes, relevance ranking, fuzzy matching. Gives up: being a source of truth — it is a
derived index, and rebuildable.

Postgres' built-in full-text search with a GIN index handles more than people expect. Move to a
dedicated engine when you need relevance tuning, faceting and typo tolerance, and keep Postgres as
the system of record.

### Graph (Neo4j, or recursive CTEs in Postgres)

Traversals of arbitrary depth. Gives up: general-purpose everything else.

Right when traversal *is* the product — social graphs, fraud rings, dependency resolution. For
bounded depth, Postgres recursive CTEs are usually enough. "We have relationships in our data" is
not a reason; every relational database is named after relations.

### Time series (TimescaleDB, InfluxDB, Prometheus)

Append-heavy, time-ordered, queried in windows, downsampled as it ages. `plays` in this lab is
exactly this shape.

Timescale is a Postgres extension, which makes it the low-risk option: partitioning, compression
and time-bucketing without leaving SQL or your existing tooling.

---

## Polyglot persistence, and its bill

Multiple stores, each suited to its job, is a legitimate architecture. It also multiplies:
operational surface, failure modes, on-call knowledge, and — the one people underestimate — **the
number of places the same fact lives.**

Two copies of a fact will disagree. Not might: will. So every additional store needs an answer to:
which one is authoritative, how does the other get updated, what happens when that pipeline fails,
and how do you detect drift.

The healthy pattern is a clear **system of record** plus derived stores that can be rebuilt from
it. A search index is a projection of Postgres. A cache is a projection. An analytics warehouse is
a projection. If you cannot say which store is authoritative for a fact, that is a design bug, and
it will surface as a support ticket about numbers that do not match.

---

## The honest defaults

If you want a heuristic rather than a framework:

1. **Start with Postgres.** It does relational, JSON, full-text, geospatial, time-series (with
   Timescale), and queues (`SKIP LOCKED`) well enough that one node covers most systems for years.
2. **Add a cache** when you have measured a read path that is hot and tolerant of staleness.
3. **Add a column store** when analytical queries start hurting the transactional workload.
4. **Add a search engine** when relevance becomes a feature rather than a filter.
5. **Add anything else** when you can name the access pattern Postgres cannot serve and the thing
   you are giving up to serve it.

The order matters: each step adds a copy of the truth, and copies are the expensive part.

---

## Common failure modes, named

- **The document database for relational data** — chosen for schema flexibility, discovered later
  to need joins, now doing them in application code.
- **Analytics on the production primary** — one dashboard query scanning `plays` while checkouts
  wait behind it.
- **The cache with no invalidation story** — fast, wrong, and impossible to debug because the two
  copies disagree only sometimes.
- **The queue that is a table but was never designed as one** — polling with `SELECT ... LIMIT 1`,
  two workers claiming one job, no `SKIP LOCKED`.
- **Sharding at 10 GB** — a distributed system adopted to solve a missing index.
- **The replica read that races the write** — user updates their profile, sees the old one, files
  a bug you cannot reproduce.
- **Postgres declared "outgrown"** without anyone reading a query plan.

---

## What you should now be able to do

- [ ] Frame a storage choice as an access pattern plus an explicit trade, not a technology
      preference.
- [ ] Say what each of the six store families gives up, not just what it gives.
- [ ] Argue for `jsonb` in Postgres over a separate document store, and name where that stops.
- [ ] Explain why polyglot persistence's real cost is duplicated facts.
- [ ] Identify the system of record for every fact in a design.
- [ ] Give the ordered list of what to do before adding a second store.

---

## Artifact for this module — and for the course

A **one-page storage decision record** for a real project. It should contain:

- **Context** — the system, its scale now and its expected scale, the team that will operate it.
- **The access patterns** — the specific reads and writes that matter, with rough volumes and
  latency requirements. Be concrete: "top 10 tracks for an artist over 90 days, ~200 rps, p95 under
  100 ms" beats "fast analytics."
- **The options considered** — including "one Postgres node, indexed properly," which must always
  be on the list.
- **Measurements** — real numbers from this lab or from your own system. Query plans, block counts,
  pool wait times, isolation-level behaviour. **A decision record with no numbers is an opinion.**
- **The decision**, and the trade you are accepting — what you are giving up, named explicitly.
- **The operational cost** — what breaks at 3am, who knows how to fix it, what you now have to
  monitor.
- **What would change your mind** — the specific measurement or growth threshold that would make
  you revisit this. A decision with no trigger for revisiting is a decision nobody will revisit.

That last section is the one that separates an engineering document from a justification. It is
also the one that makes the record useful in a year, when the person reading it is you, and the
numbers have changed.

---

Back to the [course plan](../README.md).
