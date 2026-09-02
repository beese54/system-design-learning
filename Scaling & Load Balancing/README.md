# Scaling & Load Balancing — a hands-on course

**Course 3 in the system design series.** [Course 2 was Data & Storage](../Data%20&%20Storage/README.md),
where you fixed the queries, sized the pool and learned what a read actually costs. It measured
everything below the application and quietly assumed one thing above it: that there was exactly one
application process, and that its capacity was somebody else's problem.

This course opens that box. Same music catalogue, same three artists — now behind a fleet of app
instances, a load balancer you can read, and health checks you can break on purpose.

Every module has three parts: **read it**, **run it**, **build it**. The rule carries over:

> **A skill counts as learned only when an artifact proves it.**
> "Read the lesson" is not a milestone. "Broke a backend under load, timed the ejection, and wrote
> down what the error budget actually cost" is.

---

## Set up once (2 minutes)

You need Docker running for the shared state store. Everything else — the instances, the balancer,
the load generator — runs on your machine, exactly as in Courses 1 and 2.

```bash
cd "Scaling & Load Balancing/labs"
docker compose up -d db      # seeds in seconds, not minutes
npm install
npm start
```

Then open **http://localhost:4300**. It starts on a different port from the API Design lab (4000)
and the Data & Storage lab (4100), so all three can run at once.

| Command | What it does |
|---|---|
| `npm start` | The visual lab |
| `npm run nginx:up` | The optional nginx comparison for Tab 8 |
| `npm run db:psql` | A psql shell inside the container |
| `npm run db:reset` | Wipe and re-seed |
| `node fleet/instance.js --id=i1 --port=4311` | Run one app instance by hand |
| `node lb/balancer.js --backends=4311,4312` | Run the balancer by hand |

**Run the preflight in Tab 1 before anything else.** It measures your cores, calibrates the unit of
work, finds your platform's timer floor and measures the load generator's own ceiling. Every other
number in the course is a comparison, and a comparison without a known noise floor is a rumour.

---

## What the lab actually runs

```
your browser  ->  lab host :4300      the UI and the control plane
                  balancer :4310      the front door under test
                  instances :4311+    app processes, spawned and broken on demand
                  postgres :55433     the shared state store
                  nginx :4320         optional, Tab 8 only
```

The fleet size adapts to your machine. On the machine this was written on, 32 logical cores with 24
claimed by WSL2 left a **fleet budget of 4** — and the lab says so in the banner rather than drawing
a curve it does not have the cores to produce.

---

## The modules

| # | Module | Read | Do in the lab | Proof artifact (done-when) | Time |
|---|---|---|---|---|---|
| 1 | What "slow" means | [`01`](lessons/01-what-slow-means.md) | Tab 1 · Capacity | A **capacity profile** of one real service: its plateau, the concurrency it arrives at, and the resource that ran out | 1.5 h |
| 2 | Vertical scaling | [`02`](lessons/02-vertical-scaling.md) | Tab 2 · Vertical | A **vertical scaling record** with the efficiency at each step and the point it stopped paying | 1.5 h |
| 3 | Horizontal scaling | [`03`](lessons/03-horizontal-scaling.md) | Tab 3 · Horizontal | A **statelessness inventory**: what is stuck inside one of your processes, and what breaks if it moves | 2 h |
| 4 | The load balancer | [`04`](lessons/04-the-load-balancer.md) | Tab 4 · Balancer | A **measured policy comparison** with one backend degraded, and the share each policy sent it | 2 h |
| 5 | Health checks | [`05`](lessons/05-health-checks.md) | Tab 6 · Health | A **health check specification**: what each endpoint touches, and the fault that would pass it | 1.5 h |
| 6 | Failure and recovery | [`06`](lessons/06-failure-ejection-recovery.md) | Tab 7 · Failure | An **ejection transcript** with timings, and the error budget it cost | 2 h |
| 7 | Sessions and stickiness | [`07`](lessons/07-sessions-and-stickiness.md) | Tab 5 · Stateless | A **session decision record**: sticky or shared, with the measured cost of the one you rejected | 1.5 h |
| 8 | Autoscaling | [`08`](lessons/08-autoscaling.md) | Tab 1 + Tab 3 | A **capacity plan** with a scaling signal, a threshold, and the cost of being wrong each way | 1.5 h |
| 9 | What does not scale | [`09`](lessons/09-what-doesnt-scale.md) | Tab 8 · The real thing | The **course artifact** — a scaling plan for a system you actually work on | 2 h |

**Total: about 15 focused hours.**

Max two modules in flight. A course with five parallel starts is a graveyard.

---

## The rhythm for each module

1. **Read** the lesson (15–20 min). Each ends with *What you should now be able to do*.
2. **Run** the matching tab. Break things deliberately. The lab instruments what a balancer normally
   hides — which instance answered, why it was ejected, how long detection took, and what it cost.
3. **Read the source.** Small and framework-free, like Courses 1 and 2:
   - `labs/lb/policies.js` — all five balancing policies, a few lines each, with what each buys *and* costs
   - `labs/lb/health.js` — the ejection state machine, every parameter named with its trade
   - `labs/fleet/instance.js` — the app being scaled, and the nine faults you can inject into it
   - `labs/load/driver.js` — the load generator, and the three checks that stop it lying
4. **Build** the artifact. Exercises with acceptance criteria in
   [`exercises/exercises.md`](exercises/exercises.md); worked answers in
   [`exercises/solutions.md`](exercises/solutions.md) — try first.

---

## What lives where

```
Scaling & Load Balancing/
├── README.md                     ← you are here
├── lessons/                      ← the nine lessons, in order
├── labs/
│   ├── docker-compose.yml        Postgres, and optionally nginx
│   ├── db/                       schema, light seed, pool, readiness gate
│   ├── server.js                 lab host: the UI and every endpoint
│   ├── fleet/
│   │   ├── instance.js           one app instance: five work modes, nine faults
│   │   ├── supervisor.js         spawn, kill, drain, reap
│   │   └── faults.js             the fault catalogue
│   ├── lb/
│   │   ├── balancer.js           the L7 proxy, ~200 readable lines
│   │   ├── policies.js           round robin, least conn, p2c, hash, consistent ring
│   │   ├── health.js             the ejection state machine
│   │   └── nginx.conf            the same job, annotated, in someone else's C
│   ├── load/
│   │   ├── driver.js             load generator + self-test + the 70% rule
│   │   ├── budget.js             how much of this machine is actually available
│   │   ├── calibrate.js          work unit, timer floor, thermal drift
│   │   └── histogram.js          exact percentiles; refuses sub-noise differences
│   ├── bench/                    one module per tab
│   └── ui/                       the visual lab
├── worksheets/
│   ├── capacity-planning-canvas.md
│   ├── load-balancer-decision-worksheet.md
│   └── health-check-review-checklist.md
└── exercises/
    ├── exercises.md
    └── solutions.md
```

---

## Some numbers from this lab, so you know what to expect

Real, measured on a 32-core Windows machine with a fleet budget of 4. Yours will differ; the shapes
should not.

```
Capacity           1 worker, cpu work: throughput flat 49-64 rps across concurrency 1 to 64
                   p99 103 ms -> 1,301 ms                       (12.6x, for no extra work done)

Coordinated        closed loop p99      367 ms
omission           open loop   p99   16,223 ms                  (44x, same server, same load)

Scaling out        4 instances vs 1, identical total concurrency
                   io:query   5,383 rps  vs  7,838 rps          (0.69x - the fleet was SLOWER)
                   cpu          243 rps  vs     99 rps          (2.46x)

Balancing          one instance slowed to 300 ms
                   round-robin  164.59 rps, 26.72% sent to it
                   least-conn   200.98 rps,  6.36% sent to it   (22% more throughput)

The zombie         an instance failing instantly; fair share would be 25%
                   round-robin  24.53%   least-conn  98.41%     (the clever policy loses)

Detection          dead 1,063 ms · unready 1,357 ms · hung 1,708 ms · error NEVER

The cascade        deep health check, dependency down     2 of 4 healthy
                   readiness check, same dependency down  4 of 4 healthy

Sessions           in-memory, round robin      75.35% of follow-ups hit the wrong instance
                   lose 1 of 4, modulo hash    74.4% of keys move
                   lose 1 of 4, consistent     26.1% of keys move
                   shared store                1.98 ms per request, forever
```

---

## Progress

Tick these off as the artifacts appear. An unticked box under a finished lesson means you read,
which is not the same as learned.

- [ ] M1 · What "slow" means — artifact: capacity profile with the resource that ran out named
- [ ] M2 · Vertical scaling — artifact: scaling record with the efficiency column
- [ ] M3 · Horizontal scaling — artifact: statelessness inventory
- [ ] M4 · The load balancer — artifact: measured policy comparison under a fault
- [ ] M5 · Health checks — artifact: health check specification
- [ ] M6 · Failure and recovery — artifact: ejection transcript with timings
- [ ] M7 · Sessions — artifact: session decision record with the rejected cost
- [ ] M8 · Autoscaling — artifact: capacity plan with a signal and a threshold
- [ ] M9 · What does not scale — artifact: the course scaling plan

---

## When you finish

The natural fourth course is **caching** — Redis, and the question this series has been circling
since Course 1 measured a read that cost nothing: what if you did not do the read at all? You are
well placed for it now, because you know what the read costs, what the fleet in front of it costs,
and exactly which shared thing every one of your instances is now leaning on.
