# API Design — a hands-on course

A seven-module course on what APIs are, why they are designed the way they are, and how
REST, GraphQL and gRPC differ once you stop reading about them and start sending bytes.

Every module has three parts: **read it**, **run it**, **build it**. The reading is short.
The lab is a real server on your machine with a visual front end. The build is the part
that actually teaches you — the rule of this course is:

> **A skill counts as learned only when an artifact proves it.**
> "Read the lesson" is not a milestone. "Designed the contract, ran the benchmark, wrote
> down why I chose gRPC here" is.

---

## Set up once (2 minutes)

```bash
cd "API Design/labs"
npm install
npm start
```

Then open **http://localhost:4000** — that is the visual lab. It serves all three APIs
from one process, so you can compare them under identical conditions:

| URL | What it is |
|---|---|
| `http://localhost:4000/` | The visual API Lab — seven tabs, one per module |
| `http://localhost:4000/rest/v1/artists` | Lab 1, REST, in your browser or curl |
| `http://localhost:4000/graphql` | Lab 2, GraphQL (POST) |
| `http://localhost:4000/grpc/...` | Lab 3, the browser bridge to the gRPC service |
| `http://localhost:4000/compare` | The live benchmark the Compare tab charts |

The gRPC service starts automatically on `127.0.0.1:50051`. To run it separately (recommended
once, so you can watch it as its own process): `npm run grpc` in a second terminal.

All three labs expose the **same tiny music catalogue** — artists → albums → tracks. Same data,
three contracts. Every difference you observe is a design difference, not a data difference.

---

## The modules

| # | Module | Read | Do in the lab | Proof artifact (done-when) | Time |
|---|---|---|---|---|---|
| 1 | What an API is | [`lessons/01-what-is-an-api.md`](lessons/01-what-is-an-api.md) | Tab 1 · Anatomy | Write a one-page description of an API you use daily: its contract, what it hides, what would break if it changed. | 45 min |
| 2 | APIs in system architecture | [`lessons/02-apis-in-system-architecture.md`](lessons/02-apis-in-system-architecture.md) | Tab 2 · Architecture | Draw your own system's API map: consumers, edge, services, stores. Mark which boundaries are expensive to change. | 1 h |
| 3 | Principles of good API design | [`lessons/03-design-principles.md`](lessons/03-design-principles.md) | Tab 3 · REST (compare the good and BAD endpoints) | Take a bad API you have met and rewrite its contract against the 10 principles. Note what each fix buys. | 1.5 h |
| 4 | How protocols shape API design | [`lessons/04-protocols-shape-design.md`](lessons/04-protocols-shape-design.md) | Tabs 3–5, watch the headers and byte counts | A written comparison of HTTP/1.1, HTTP/2 and what each makes cheap or impossible, with numbers from your own run. | 1.5 h |
| 5 | The API design process | [`lessons/05-the-design-process.md`](lessons/05-the-design-process.md) | Tab 7 · Design process (checklist) | A completed [API Design Canvas](worksheets/api-design-canvas.md) for a system you care about. | 2 h |
| 6 | The three styles, in depth | [`06-rest.md`](lessons/06-rest.md) · [`07-graphql.md`](lessons/07-graphql.md) · [`08-grpc.md`](lessons/08-grpc.md) | Tabs 3, 4, 5 + the exercises | Implement the same new feature ("playlists") in all three labs. Working code in `labs/`. | 6 h |
| 7 | Choosing and evolving | [`lessons/09-choosing-and-evolving.md`](lessons/09-choosing-and-evolving.md) | Tab 6 · Compare (run the benchmark) | A one-page decision record for a real project: chosen style, measured numbers, what would change your mind. | 1.5 h |

**Total: about 15 focused hours.** Two weeks at an hour a day, or two solid weekends.

Max two modules in flight. A course with five parallel starts is a graveyard.

---

## The rhythm for each module

1. **Read** the lesson (10–20 min). Every lesson ends with *What you should now be able to do*.
2. **Run** the matching lab tab. Click every button. Watch the numbers change — bytes, round
   trips, datastore reads. The lab instruments things a normal API hides.
3. **Read the source.** The labs are deliberately small and framework-free:
   - `labs/rest/api.js` — 230 lines, every status code and header is a visible decision
   - `labs/graphql/schema.js` — the SDL plus resolvers, including a DataLoader-in-8-lines
   - `labs/grpc/catalog.proto` + `labs/grpc/server.js` — the compiled contract
4. **Build** the artifact. Exercises with acceptance criteria are in
   [`exercises/exercises.md`](exercises/exercises.md); worked solutions in
   [`exercises/solutions.md`](exercises/solutions.md) — try first, then read.

---

## What lives where

```
API Design/
├── README.md                     ← you are here: the plan
├── lessons/                      ← the nine lessons, in order
│   ├── 01-what-is-an-api.md
│   ├── 02-apis-in-system-architecture.md
│   ├── 03-design-principles.md
│   ├── 04-protocols-shape-design.md
│   ├── 05-the-design-process.md
│   ├── 06-rest.md
│   ├── 07-graphql.md
│   ├── 08-grpc.md
│   └── 09-choosing-and-evolving.md
├── labs/                         ← runnable code + the visual lab UI
│   ├── server.js                 lab host: serves the UI and all three APIs
│   ├── shared/catalog.js         the one dataset all three expose
│   ├── rest/api.js               Lab 1
│   ├── graphql/{schema,api}.js   Lab 2
│   ├── grpc/{catalog.proto,server.js,bridge.js}   Lab 3
│   └── ui/{index.html,app.js,styles.css}          the visual lab
├── worksheets/                   ← fill these in for your own systems
│   ├── api-design-canvas.md
│   ├── protocol-decision-worksheet.md
│   └── design-review-checklist.md
└── exercises/
    ├── exercises.md
    └── solutions.md
```

---

## Progress

Tick these off as the artifacts appear. An unticked box with a finished lesson means you read,
which is not the same as learned.

- [ ] M1 · What an API is — artifact: contract description of an API I use
- [ ] M2 · APIs in architecture — artifact: my system's API map
- [ ] M3 · Design principles — artifact: a bad contract, rewritten
- [ ] M4 · Protocols — artifact: protocol comparison with my own measurements
- [ ] M5 · Design process — artifact: a completed API Design Canvas
- [ ] M6 · The three styles — artifact: playlists feature in all three labs
- [ ] M7 · Choosing — artifact: a decision record for a real project
