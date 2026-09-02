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

Chapter I's compare benchmark had one column quietly lying: its datastore was a JavaScript
array, so every read was free. Chapter II opens that box.

## The reader

[`book/`](./book/README.md) typesets every chapter's lessons into a single-page reader.
No install step, no dependencies:

```bash
open book/index.html        # or: python -m http.server 4200 in book/
```

The markdown lessons in each chapter folder are the master copy. The reader never edits them.

---

## Running the labs

Node 20+ for both. Chapter II also needs Docker.

```bash
cd "API Design/labs"   && npm install && npm start     # → http://localhost:4000
cd "Data & Storage/labs" && docker compose up -d && npm install && npm start   # → http://localhost:4100
```

Different ports on purpose — you can run both at once and compare.

---

## Layout

```
system_design_learning/
├── API Design/          Chapter I — lessons, labs, worksheets, exercises
├── Data & Storage/      Chapter II — same, plus a containerised Postgres
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
