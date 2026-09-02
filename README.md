# System Design — a hands-on course

A course I am building for myself, one chapter at a time, on how real systems are put
together. Every chapter is **read it · run it · build it**: a short set of lessons, a lab
that actually runs on your machine, and a proof artifact you have to produce yourself.

> **A skill counts as learned only when an artifact proves it.**
> "Read the lesson" is not a milestone. "Reproduced the anomaly, wrote down the interleaving
> that causes it, and shipped the fix" is.

Every chapter reuses the **same tiny music catalogue** — artists → albums → tracks. Same
domain throughout, so every difference you observe between chapters is a *design* difference,
not a domain difference.

---

## Chapters

| # | Chapter | What it answers | Lab | Status |
|---|---|---|---|---|
| I | [API Design](./API%20Design/README.md) | Why APIs are shaped the way they are, and how REST, GraphQL and gRPC differ once you send real bytes | `localhost:4000` | Built |
| II | [Data & Storage](./Data%20&%20Storage/README.md) | What a read actually costs — query plans, indexes, transactions, locks — against a real Postgres holding a million rows | `localhost:4100` | Built |
| III | [Scaling & Load Balancing](./Scaling%20&%20Load%20Balancing/README.md) | What happens above the database: one process becomes a fleet, a balancer decides where each request goes, and a health check decides which machines still count | `localhost:4300` | Built |

Each chapter opens by naming something the previous one was quietly assuming. Chapter I's compare
benchmark had a column that lied: its datastore was a JavaScript array, so every read was free.
Chapter II opened that box — and then assumed there was exactly one application process in front of
it. Chapter III opens that one.

## The reader

[`book/`](./book/README.md) typesets every chapter's lessons into a single-page reader.
No install step, no dependencies:

```bash
open book/index.html        # or: python -m http.server 4200 in book/
```

The markdown lessons in each chapter folder are the master copy. The reader never edits them.

---

## Running the labs

Node 20+ for all three. Chapters II and III also need Docker.

```bash
cd "API Design/labs"              && npm install && npm start                    # → :4000
cd "Data & Storage/labs"          && docker compose up -d && npm install && npm start   # → :4100
cd "Scaling & Load Balancing/labs" && docker compose up -d db && npm install && npm start  # → :4300
```

Different ports on purpose — you can run all three at once and compare. Each lab owns its own
Compose project, so starting one never disturbs another.

---

## Layout

```
system_design_learning/
├── API Design/          Chapter I — lessons, labs, worksheets, exercises
├── Data & Storage/      Chapter II — same, plus a containerised Postgres
├── Scaling & Load Balancing/
│                        Chapter III — a fleet, a balancer, and health checks you can break
├── book/                the reader (build from the lesson markdown)
├── docs/architecture.md how it all fits together, and why
└── tasks/               build plans and verification notes per chapter
```

Each chapter folder follows the same shape: `lessons/` (numbered markdown), `labs/` (a
framework-free Node server plus a visual UI), `worksheets/` (canvases and checklists to fill
in), `exercises/` (problems with worked solutions).

---

## Conventions

- **Framework-free labs.** Plain Node HTTP servers and vanilla front ends. The point is to see
  the mechanism, not a framework's abstraction over it.
- **Real numbers only.** Every claim a lesson makes is measured in the lab, not asserted. Where
  measurement contradicted a lesson, the lesson was corrected — see `tasks/`.
- **Nothing is committed that a reader cannot reproduce.** `npm install` is the only setup step
  beyond Docker.

Work in progress. New chapters land as I get to them.
