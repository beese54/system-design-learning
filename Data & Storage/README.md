# Data & Storage — a hands-on course

**Course 2 in the system design series.** [Course 1 was API Design](../API%20Design/README.md),
where you built three contracts over a music catalogue and measured what each cost. That course's
compare benchmark counted round trips and payload bytes, and one column in it was quietly lying:
the datastore was a JavaScript array, so every read was free.

This course opens that box. Same catalogue, same three artists — now with a million plays
underneath them in a real Postgres.

Every module has three parts: **read it**, **run it**, **build it**. The rule carries over from
Course 1:

> **A skill counts as learned only when an artifact proves it.**
> "Read the lesson" is not a milestone. "Reproduced the anomaly, wrote down the interleaving that
> causes it, and shipped the fix" is.

---

## Set up once (3 minutes)

You need Docker running. Only the database is containerised — the lab app runs on your machine,
exactly as in Course 1.

```bash
cd "Data & Storage/labs"
docker compose up -d      # first run seeds ~1M rows, 30-60 seconds
npm install
npm start
```

Then open **http://localhost:4100** — seven tabs, one per module. It starts on a different port
from the API Design lab (4000) so you can run both at once and compare.

| Command | What it does |
|---|---|
| `npm start` | The visual lab |
| `npm run db:psql` | A psql shell inside the container |
| `npm run db:reset` | Wipe and re-seed from scratch |
| `docker compose logs -f db` | Watch every query the lab runs, with its duration |

That last one is worth doing once. The lab sets `log_min_duration_statement=0`, so the container
log is a live feed of every statement and how long it took — deliberately excessive, and a good
way to see how much work a single click costs.

**If `npm start` says it cannot reach Postgres**, the container is probably still seeding. Watch
`docker compose logs -f db` and wait for the "Storage lab seeded" notice.

---

## The dataset

| Table | Rows | Why it is there |
|---|---|---|
| `artists` | 500 | The three from Course 1 keep their ids (`a1`, `a2`, `a3`) |
| `albums` | 2,000 | Four per artist |
| `tracks` | 22,000 | Eleven per album |
| `listeners` | 50,000 | |
| `plays` | **1,000,000** | One row per play. This is the table that makes it a storage course. |

Scale is the point. At three artists every plan is a sequential scan and every index is a waste of
disk — storage only starts teaching at size. Plays are skewed toward popular tracks, because a
uniform distribution would make every "top tracks" query boring.

**The schema ships deliberately under-indexed.** Primary keys and unique constraints have indexes;
nothing else does, including the foreign keys. That is Module 4's starting position, not an
oversight.

---

## The modules

| # | Module | Read | Do in the lab | Proof artifact (done-when) | Time |
|---|---|---|---|---|---|
| 1 | Why storage is the hard part | [`01`](lessons/01-why-storage-is-the-hard-part.md) | Tab 1 · Schema | A **storage cost map** of a system you work on: top 5 reads, top 3 writes, what happens at 100× | 1 h |
| 2 | Schema design and constraints | [`02`](lessons/02-schema-design-and-constraints.md) | Tab 1 · Schema | A schema for a domain you know, with **one line per constraint saying what breaks without it** | 1.5 h |
| 3 | How a query actually runs | [`03`](lessons/03-how-a-query-actually-runs.md) | Tab 2 · Query plans | A slow query **diagnosed by node**, fixed, both plans captured | 2 h |
| 4 | Indexes | [`04`](lessons/04-indexes.md) | Tab 3 · Indexes | A **before/after index record** including the measured write cost — arguing both sides | 2 h |
| 5 | Transactions and isolation | [`05`](lessons/05-transactions-and-isolation.md) | Tab 4 · Transactions | A real read-to-decide-then-write transaction, its breaking interleaving, and **the anomaly reproduced in the lab** | 3 h |
| 6 | Concurrency and locking | [`06`](lessons/06-concurrency-and-locking.md) | Tab 5 · Locks | A deadlock transcript plus the **lock-ordering rule** that prevents it | 2 h |
| 7 | Connections and the N+1 | [`07`](lessons/07-connections-and-n-plus-1.md) | Tabs 6 · N+1, 7 · Pool | A **pool sizing note** for a real service, including what happens during a deploy | 1.5 h |
| 8 | Scaling one node | [`08`](lessons/08-scaling-one-node.md) | Tab 3 + psql | A **maintenance and growth plan** for one real table | 1.5 h |
| 9 | When relational is wrong | [`09`](lessons/09-when-relational-is-wrong.md) | all tabs | A **one-page storage decision record** with your own measurements | 2 h |

**Total: about 17 focused hours.**

Max two modules in flight. A course with five parallel starts is a graveyard.

---

## The rhythm for each module

1. **Read** the lesson (15–20 min). Each ends with *What you should now be able to do*.
2. **Run** the matching tab. Click everything. The lab instruments what a database normally hides —
   blocks read, rows discarded, queue waits, who is blocking whom.
3. **Read the source.** Small and framework-free, like Course 1:
   - `labs/db/init/01-schema.sql` — the DDL, with every constraint explained
   - `labs/pg/plans.js` — how `EXPLAIN (FORMAT JSON)` is parsed into what you see
   - `labs/pg/scenarios.js` — the seven transaction scripts; this is where the isolation lessons live
   - `labs/pg/indexes.js` — the index candidates, each with what it buys *and* what it costs
4. **Build** the artifact. Exercises with acceptance criteria in
   [`exercises/exercises.md`](exercises/exercises.md); worked answers in
   [`exercises/solutions.md`](exercises/solutions.md) — try first.

---

## What lives where

```
Data & Storage/
├── README.md                     ← you are here
├── lessons/                      ← the nine lessons, in order
├── labs/
│   ├── docker-compose.yml        Postgres 16, tuned for teaching
│   ├── db/init/{01-schema,02-seed}.sql
│   ├── server.js                 lab host: serves the UI and every endpoint
│   ├── pg/
│   │   ├── db.js                 the pool, the counters, the named sessions
│   │   ├── plans.js              EXPLAIN parsing + the query library
│   │   ├── indexes.js            create/drop/probe + the write-cost benchmark
│   │   ├── scenarios.js          the seven transaction and lock scripts
│   │   └── workloads.js          N+1 comparison, pool saturation
│   └── ui/                       the visual lab
├── worksheets/
│   ├── schema-design-canvas.md
│   ├── index-decision-worksheet.md
│   └── transaction-review-checklist.md
└── exercises/
    ├── exercises.md
    └── solutions.md
```

---

## Some numbers from this lab, so you know what to expect

These are real, measured on the shipped dataset. If your figures are in the same shape, everything
is working.

```
Missing index      count(*) WHERE track_id='t5'
                   20.2 ms / 36,372 blocks  →  1.25 ms / 10 blocks     (index only scan)

Write tax          20,000 inserts, 2 indexes → 490 ms
                   20,000 inserts, 6 indexes → 639 ms                  (+30%)

Write skew         READ COMMITTED  → 0 featured albums, rule broken, no error
                   SERIALIZABLE    → 40001, rule holds

Pool of 8          concurrency 8   → p95 queue wait  14 ms
                   concurrency 40  → p95 queue wait 213 ms             (81% of latency is queueing)

Connections        new connection 11.6 ms  vs  pooled 0.91 ms          (12.7×)
```

---

## Progress

Tick these off as the artifacts appear. An unticked box under a finished lesson means you read,
which is not the same as learned.

- [ ] M1 · Why storage is hard — artifact: storage cost map
- [ ] M2 · Schema and constraints — artifact: a schema where every constraint has a named failure
- [ ] M3 · Query plans — artifact: a slow query diagnosed by node and fixed
- [ ] M4 · Indexes — artifact: before/after record with the write cost
- [ ] M5 · Transactions — artifact: an anomaly reproduced, and the fix
- [ ] M6 · Locking — artifact: deadlock transcript + lock-ordering rule
- [ ] M7 · Connections — artifact: pool sizing note
- [ ] M8 · Scaling one node — artifact: maintenance and growth plan
- [ ] M9 · Choosing a store — artifact: storage decision record

---

## When you finish

[Course 3 is **Scaling & Load Balancing**](../Scaling%20&%20Load%20Balancing/README.md) — the tier
above everything you just measured. This course tuned one application process in front of one
database and never asked what happens when that process is not enough. Course 3 turns it into a
fleet, puts a load balancer in front that you can read line by line, and breaks health checks on
purpose to watch a fleet eject itself.

You will be well placed for it, because you now know what a read costs — and the first thing that
course measures is that scaling out an I/O-bound service does not make it faster, which only makes
sense once you know where the time was actually going.

After that comes **caching**, and the question this course deliberately left open: what if you do
not do the read at all?
