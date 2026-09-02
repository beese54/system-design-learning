# Exercises

Every exercise has **acceptance criteria** — conditions that can fail. Try each one before reading
[`solutions.md`](solutions.md); the worked answers are worth much less if you have not first been
wrong about something.

Run the lab first:

```bash
cd "Scaling & Load Balancing/labs"
docker compose up -d db
npm install && npm start          # http://localhost:4300
```

Several of these ask you to edit the lab's own source. That is intentional — the balancer is two
hundred readable lines precisely so that you can change it and see what happens.

---

## 1 · Establish your own numbers  *(Lesson 01, 20 min)*

Before anything else, run the preflight in Tab 1 and write down what this machine actually is.

**Acceptance criteria**
- [ ] You have recorded your core count, fleet budget, calibrated work unit and the load driver's
      ceiling.
- [ ] You can say what your platform's timer floor is and whether it is coarse.
- [ ] You have run *Measure the noise* and can state the smallest difference worth believing on this
      machine.
- [ ] You can explain, in one sentence, why every subsequent number depends on this one.

---

## 2 · Find the plateau, and disprove the obvious fix  *(Lesson 01, 30 min)*

Ramp concurrency in `cpu` mode against a single worker. Then predict, before you run it, what
happens at double the highest concurrency.

**Acceptance criteria**
- [ ] You have the full table of concurrency against rps, p50 and p99.
- [ ] Throughput between your lowest and highest concurrency differs by less than your measured noise
      floor, or you can explain why it does not.
- [ ] You have used Little's Law to predict p50 at the highest concurrency and compared it to the
      measurement. They should agree within a few per cent.
- [ ] You can state what "adding more threads" would do to this service, with a number.

---

## 3 · Break a load test on purpose  *(Lesson 01, 30 min)*

Run *Closed loop vs open loop*. Then make the gap between them bigger.

**Acceptance criteria**
- [ ] You have both p99 figures at the same offered load, and the ratio between them.
- [ ] You can explain why the closed loop reports a better number without the server being faster.
- [ ] You have found an offered rate at which the two roughly agree, and one where they differ by
      more than 10×, and can say what distinguishes them.
- [ ] You can describe how you would detect coordinated omission in a load-test tool you did not
      write.

---

## 4 · The control experiment, run yourself  *(Lesson 03, 45 min)*

Tab 3's control experiment is the chapter's central claim. Reproduce it, then attack it.

**Acceptance criteria**
- [ ] You have the ratio for both `io:query` and `cpu`, from your own machine.
- [ ] You can explain why one process can match or beat four on I/O-bound work.
- [ ] You have changed `POOL_SIZE` in `labs/db/pool.js` and shown that it moves the I/O result — which
      is the point: the pool was the variable, not the instance count.
- [ ] You have written down three reasons to run a fleet that survive this result intact.

---

## 5 · Make a policy matter  *(Lesson 04, 45 min)*

Run Tab 4 with *all healthy* and then with one instance `slow`.

**Acceptance criteria**
- [ ] You have throughput and the share sent to the sick instance, for all three policies, in both
      conditions.
- [ ] You can explain why the healthy run shows no difference between policies.
- [ ] You have identified which policy you would deploy and named the condition under which you would
      regret it.
- [ ] Stretch: add a fourth policy to `labs/lb/policies.js` — random selection — and predict where it
      lands relative to the other three before measuring.

---

## 6 · Walk into the black hole  *(Lesson 04, 30 min)*

Run the zombie. Then work out how to defend against it.

**Acceptance criteria**
- [ ] You have the share of traffic each policy sent into the zombie, against the fair share.
- [ ] You can explain why the most sophisticated policy performed worst, in terms of the signal it
      uses.
- [ ] You have re-run it with health checking enabled and measured how long the damage lasts.
- [ ] You can describe a change to `least-conn` that would fix this, and say what it would cost.

---

## 7 · Time every kind of failure  *(Lesson 05, 45 min)*

Use *Time it* in Tab 6 for `dead`, `hung`, `unready` and `error`.

**Acceptance criteria**
- [ ] You have four detection times, and can explain why each differs from the others.
- [ ] You can say which of them a TCP-only health check would miss entirely.
- [ ] You have found the fault that is never detected by probing, and explained why.
- [ ] You have changed `timeoutMs` in `labs/lb/health.js` and shown that it moves exactly one of the
      four numbers.

---

## 8 · Cause an outage with a health check  *(Lesson 06, 45 min)*

Run the cascade. Then reproduce it deliberately without using the button.

**Acceptance criteria**
- [ ] You have both phases recorded: healthy count under a deep check and under readiness, with the
      dependency broken in both.
- [ ] You can state plainly what caused the outage.
- [ ] You have observed the panic threshold refusing to eject, and can say what it prevented.
- [ ] You have set `panicThreshold` to 0 and reproduced the total outage, then set it back.

---

## 9 · Price statelessness  *(Lesson 07, 45 min)*

Run all three buttons in Tab 5.

**Acceptance criteria**
- [ ] You have the wrong-instance rate for in-memory sessions and can derive it from first
      principles.
- [ ] You have the reshuffle percentages for modulo and consistent hashing, and can explain the
      difference geometrically.
- [ ] You have the per-request cost of the shared store, and can say what it buys.
- [ ] You have changed the virtual-node count in `buildRing()` and measured its effect on load skew.

---

## 10 · Read someone else's balancer  *(Lesson 04, 45 min)*

Start nginx (`npm run nginx:up`) and open Tab 8.

**Acceptance criteria**
- [ ] You have measured the container hop and can explain why this tab refuses a throughput
      comparison.
- [ ] You have mapped at least six nginx directives to the lines of this lab that do the same job.
- [ ] You can explain why open-source nginx has no active health check, and who pays for detection as
      a result.
- [ ] You have changed `nginx.conf` to `least_conn`, reloaded, and confirmed the behaviour changed.

> This is the counterpart to Course 1's protocol comparison and Course 2's index probe: the point is
> not that your version is as good, it is that you now know exactly which twelve lines of someone
> else's config correspond to which decisions.

---

## 11 · The course artifact  *(Lesson 09, 90 min)*

A **scaling plan** for a system you actually work on. Not this lab.

Use [`../worksheets/capacity-planning-canvas.md`](../worksheets/capacity-planning-canvas.md) for the
numbers and [`../worksheets/health-check-review-checklist.md`](../worksheets/health-check-review-checklist.md)
for the reliability half.

**Acceptance criteria**
- [ ] Measured capacity per instance, with the resource that ran out named.
- [ ] Current topology: how many instances, behind what, sticky or shared.
- [ ] The three things you would do first if traffic doubled, in order, with expected cost.
- [ ] An explicit list of what does not scale horizontally in your system.
- [ ] A trigger to revisit: a metric and a threshold, not a feeling.
- [ ] If you do not know your capacity, that is written down as finding number one.

---

## Self-check: are you done?

- [ ] I have a measured capacity number for something real, not an estimate.
- [ ] I have caused an outage with a health check and understood why.
- [ ] I have seen the cleverest load-balancing policy do the worst possible thing.
- [ ] I can say what horizontal scaling actually buys, and it is not throughput.

If all four are ticked, you did not read a scaling course — you ran one.
