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
