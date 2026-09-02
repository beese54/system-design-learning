# Course 2 — Data & Storage

Status: BUILT AND VERIFIED (2026-09-01). Approved by user; folder named "Data & Storage".

Governing rule (inherited from Course 1, Pattern AC): a skill counts as learned
only when an artifact proves it. "Read the lesson" is not a milestone.

## Decisions locked
- Topic: Data & storage (Postgres), chosen over caching / messaging / scale.
- Continuity: extends the API Design music catalogue (artists -> albums -> tracks),
  so every observed difference is a storage difference, not a domain difference.
- Docker: Postgres 16 in a container; the lab app runs on host Node, as in Course 1.
  One new npm dependency (`pg`). Otherwise framework-free.

## Design problem to solve
Course 1's catalogue has 3 artists. At that size every query plan is a seq scan and
every index is pointless. The seed must generate enough rows (~1M plays) that
index-vs-scan differs by orders of magnitude, while the familiar 3 artists stay on
the surface so the domain costs nothing to relearn.

## Build checklist
- [x] Scaffold `Data and Storage/` (lessons, labs, worksheets, exercises)
- [x] `labs/docker-compose.yml` — postgres:16, healthcheck, named volume
- [x] `labs/db/init/01-schema.sql` — catalogue + plays, constraints and FKs
- [x] `labs/db/init/02-seed.sql` — 3 artists on top, ~1M plays underneath
- [x] `labs/server.js` — lab host, instrumented endpoints (framework-free)
- [x] `labs/ui/` — 7 tabs (Schema, Plans, Indexes, Transactions, Locks, N+1, Compare)
- [x] Lessons 01-09
- [x] Worksheets: schema canvas, index decision, query review checklist
- [x] Exercises + worked solutions
- [x] README with the module table and progress boxes
- [x] Verify: compose up clean from zero, every tab returns real numbers

## Done-when (course level)
- [x] `docker compose up` from a cold machine yields a working lab, no manual steps
- [x] The Indexes tab shows a real before/after with a plan change, not a mock
- [x] The Transactions tab reproduces an actual anomaly that vanishes when the
      isolation level is raised
- [x] Every module's proof artifact is checkable by a stranger

## Review

Built as `Data & Storage/` — a sibling of `API Design/`, not nested inside it.
9 lessons, 7 lab tabs, 3 worksheets, 11 exercises with worked solutions.

**Verified, not assumed:**
- Cold `docker compose down -v && up` → healthy in 27s with exactly 1,000,000 plays.
- 17/17 endpoints smoke-tested on a freshly seeded database.
- All 7 transaction scenarios produce their intended outcome at each isolation level.
- Every element id referenced by the UI exists in the HTML.

**Three defects found and fixed during verification:**

1. **The healthcheck lied.** It queried `plays`, which exists (empty) from the moment the
   schema runs, so the container reported healthy with 0 rows seeded — `npm start` could
   have connected to a half-loaded database. Fixed with a `lab_ready` sentinel table
   created by the seed's final statement; `ping()` now reads that too.

2. **A lesson taught something false.** Lesson 04 claimed the planner would ignore the
   low-selectivity `plays(device)` index. Measurement disagreed: it IS used, as an
   index-only scan, and is 10x faster for `count(*)`. Rewrote the section around the real
   finding — an index wins when it lets you avoid work, and selectivity is only one way to
   do that. The lab candidate now uses `avg(ms_played)` (~10% win, the genuinely marginal
   case) and says so.

3. **The deadlock's 40P01 was being swallowed.** A blocked statement's result was discarded
   when the block cleared, so the deadlock scenario finished with no error visible. The
   history entry is now patched in place when the statement finally resolves.

Also verified before publishing them: both exercise-6 answers (lock-the-set, and
materialise-the-conflict) actually hold at READ COMMITTED against two live sessions.

**Not done / deferred:** the caching + load balancing course (proposed as course 3).

---

# The book — a reader for the course

Status: BUILT AND VERIFIED IN-BROWSER (2026-09-01).

Inspired by github.com/mengto/complete-shelf. Decisions taken with the user after a mockup:
scroll-within-lesson (not fixed spreads), CSS 3D cover (not Three.js), local folder with a
build script, lessons only.

Key judgement: complete-shelf gives each volume a few hundred words of decorative sample
text, so its curved WebGL page-turn IS the product. This book is 21,881 words with 54 code
blocks and 20 tables that get studied. Text on curved geometry is a texture - unselectable,
uncopyable, unsearchable - so the ceremony was kept and the curvature dropped.

- [x] book/build.mjs — markdown -> content.js, no dependencies
- [x] book/index.html + reader.css + reader.js — cover, contents, reading, keyboard, resume
- [x] book/README.md — how to add Chapter III
- [x] Verified in Chrome: cover, title page, chapter page, lessons in both chapters,
      light and dark, tables, code, callouts, checklists, resume. No console errors.

## Bugs found by looking at it in a browser rather than assuming

1. **Every paragraph in the book had lost its spacing.** `.prose p{margin:0}` is (0,1,1)
   and sat after `.prose > * + *{margin-top:1.05em}` at (0,1,0), so the reset silently
   beat the spacing rule. Replaced with `.prose > *{margin:0}` at equal specificity.
2. **Deep links rendered behind the cover.** The reveal only ran on first load, so a hash
   change while the cover showed updated the title bar and painted a hidden page.
3. **Bold containing italic broke.** `**a *b* c**` left literal asterisks, because the bold
   pattern refused any inner asterisk. 6 occurrences across Chapter II.
4. **A fenced code block inside a list item was eaten.** Lesson 6 indents SQL under a
   bullet; the continuation-line handler folded it into prose and ate the fences.
5. **Lesson changes scrolled smoothly instead of jumping.** `'instant' in window` is always
   false, so it fell through to `auto` under a global `scroll-behavior: smooth`.
6. `clamp(20px,4vw,10px)` had min > max in six places and silently collapsed to 20px.

Also added: code blocks and tables break out past the prose measure above 1180px, so a
query plan is readable rather than horizontally scrolled.

**Not verified:** opening via `file://` directly — the browser tooling cannot navigate to
file URLs. Confirmed by inspection instead: no module scripts, no fetch, relative paths
only, storage access wrapped in try/catch.

---

# Course 3 — Scaling & Load Balancing

Status: BUILT AND VERIFIED (2026-09-03). Plan approved by user; folder named
"Scaling & Load Balancing".

Governing rule (inherited from Courses 1 and 2, Pattern AC): a skill counts as
learned only when an artifact proves it.

## Decisions locked
- Topic: the tier above the database — vertical and horizontal scaling, load balancers,
  health checks. Chosen by the user; caching deferred to Course 4.
- Continuity: extends the same music catalogue. State tables are `sessions` and
  `play_queues` rather than a shopping cart, because the shared-domain invariant in
  docs/architecture.md would otherwise have been broken for the first time.
- Balancer: hand-rolled Node L7 proxy to learn from, plus nginx as a comparison —
  behaviour only, never throughput (the container hop makes that dishonest).
- App tier: host child processes, not containers, as in Courses 1 and 2.
- Database: Chapter III owns its own Postgres on 55433 with a light seed, so the
  chapter is self-contained and both courses can run at once.

## Design problem to solve
A laptop is one box, and a course teaching "run many boxes" on one box will lie unless
the per-request work is chosen deliberately. Each instance therefore has selectable work
modes: `cpu` (a calibrated busy-loop) where instance count is causally the variable, and
`io:query` / `io:scan` / `io:sleep` where it is not. The contrast between them is the
chapter's instrument.

## Build checklist
- [x] Scaffold `Scaling & Load Balancing/` (lessons, labs, worksheets, exercises)
- [x] `labs/docker-compose.yml` — postgres:16 on 55433 + optional nginx profile
- [x] `labs/db/` — schema, light seed (~50k plays), pool, `lab_ready` readiness gate
- [x] `labs/fleet/` — instance (5 work modes, 9 faults), supervisor, fault catalogue
- [x] `labs/lb/` — balancer, 5 policies, ejection state machine, annotated nginx.conf
- [x] `labs/load/` — driver + worker, budget, calibration, histogram
- [x] `labs/bench/` — one module per tab
- [x] `labs/server.js` + `labs/ui/` — 8 tabs
- [x] Lessons 01-09
- [x] Worksheets: capacity canvas, balancer decision sheet, health check checklist
- [x] Exercises + worked solutions (11, with the last as the course artifact)
- [x] README with the module table, reference numbers and progress boxes
- [x] Repo wiring: root README, architecture doc, book.config.json, this file

## Done-when (course level)
- [x] `docker compose up -d db && npm install && npm start` works from cold, no manual steps
- [x] Every lesson number came from the lab rather than from a textbook
- [x] The chapter's central claim is measured, and it contradicted the obvious version
- [x] Every module's proof artifact is checkable by a stranger

## Review

Built as `Scaling & Load Balancing/` — a sibling of the first two courses. 9 lessons,
8 lab tabs, 3 worksheets, 11 exercises with worked solutions, ~5,000 lines of lab.

**The plan was wrong and the measurement caught it.** The approved plan's centrepiece was
that `io` mode would show horizontal scaling beating vertical. An adversarial review
predicted this was false, and the lab confirmed it: with identical total concurrency, four
instances managed 5,383 rps against a single instance's 7,838 — a ratio of 0.69. One event
loop was never the constraint for I/O-bound work, so the fleet only added a proxy hop in
front of work that was already free. Lesson 03 was rewritten around the honest result:
scaling out buys availability, deployability and blast radius, not throughput. The same
comparison in `cpu` mode gives 2.46, and that inversion is now the chapter's spine.

**Verified, not assumed:**
- Cold `docker compose up -d db` + `npm start` on Windows 11, both course databases healthy
  side by side, Chapter II reseeded to its full 1,000,000 plays.
- Every endpoint exercised; the UI opened in a real browser and driven through the tabs.
- Hard-killing the lab host with `Stop-Process -Force` left zero orphaned instances and
  zero held ports.
- `node book/build.mjs` reports `III. Scaling & Load Balancing 9 lessons, 12,807 words`,
  with 10 tables, 21 code blocks and zero dead links.

**Defects found by running it rather than reading it:**

1. **Compose project collision.** Every course keeps its lab in a folder called `labs`, so
   Compose derived the same project name for all of them, and Chapter III's first start
   recreated Chapter II's container. Both compose files now set an explicit `name:`.
2. **`dead` was not dead.** `server.close()` stops new connections but leaves established
   keep-alive sockets working, so the health checker kept getting healthy replies over the
   connection it already had and a dead instance was never ejected.
3. **Broken instances could not be revived.** Revive went over HTTP, which a `dead`
   instance has no listener for and a `hung` one never answers. Moved to IPC — the control
   path must not share a failure domain with the thing it is rescuing.
4. **The fault catalogue started a server.** The Health tab imported `STATES` from
   `instance.js`, which is a script with side effects, so the lab host quietly started an
   app instance inside itself and reported it as an orphan. Extracted to `fleet/faults.js`.
5. **Knee detection reported nonsense.** Taking the single highest rps as the peak let the
   noisiest sample define the answer, so a visibly flat curve reported its knee at the last
   concurrency tested. Found by looking at the chart in a browser.
6. **Two tabs reported impossible numbers.** In-memory sessions said 100% against a theory
   of 75% (the simulation was not interleaving requests); the zombie tab said 0% because
   passive health checking ejected the zombie before the policy could misbehave.

**The nginx tab, verified against a live container.** The hop is real and worth the refusal
to compare throughput: direct to an instance is 0.88 ms p50 through nginx against 0.14 ms
direct, so the container's virtual network adds 0.74 ms to an endpoint that does nothing.
The behaviour comparison came out better than expected — under a `dead` fault this lab's
active probing detected in 1,290 ms and cost zero user requests, while nginx routed away in
566 ms and cost three failed ones. nginx was faster and users paid for it, which is exactly
the trade the lesson describes and is far more persuasive as two measured numbers.

**Not done / deferred:** caching is Course 4, and Chapter II's closing paragraph now points
there via this course.
