# 05 · Health checks

Course 2 shipped a health check that lied. The Postgres container reported healthy the moment its
schema existed, because the check queried a table — and the table existed, empty, from the first
second. The lab could connect to a database that was still loading and get wrong answers from it.

That bug is the whole of this lesson. A health check is not a question about whether something is
running. It is a question about whether it can do its job, and the two come apart constantly.

---

## Three questions, not one

Most services expose one endpoint called `/health` and use it for everything. There are three
different questions, they want different answers, and the consequences of confusing them are
different:

| Check | Asks | If it fails |
|---|---|---|
| **Liveness** | Is this process alive? | Restart it |
| **Readiness** | Should it receive traffic right now? | Stop sending; do **not** restart |
| **Startup** | Has it finished coming up? | Wait; do not restart or send traffic |

Open **Tab 6 · Health**. The instances expose `/healthz`, `/readyz` and `/deepz`, and the checker
dropdown decides which one is asked. That dropdown is the most important control in the chapter.

**Liveness must be shallow.** It should check almost nothing — that the process exists and its event
loop turns. A liveness probe that touches the database will restart a perfectly healthy process
because something *else* broke, and if the database is down it will restart every instance you own,
repeatedly, while they were all fine. This is a restart storm and its cause is the health check.

**Readiness may be deeper, but only about local state.** "Am I still starting up?", "am I draining?",
"is my thread pool exhausted?" These are things this instance knows about itself.

**Startup exists because slow beginnings look like failure.** A process that takes 40 seconds to warm
its caches will fail a liveness probe with a 10-second timeout and be killed, forever, in a loop. A
separate startup probe with a longer deadline is how you avoid a service that can never start.

---

## Shallow checks miss real outages

Set the checker to `/readyz`, choose a fault, and press *Time it*. It breaks one instance and
measures how long the balancer takes to stop using it.

```
fault      detected in   the probe reported
dead          1063 ms    ECONNREFUSED
unready       1357 ms    status 503
hung          1708 ms    timeout
error            never   (the probe passed every time)
```

Four faults, four completely different stories.

**`dead`** closes its listener, so connections are refused instantly. This is the *best* kind of
failure: unambiguous, and detected in barely more than the 1,500 ms floor set by the check interval
and the failure threshold. If everything failed like this, health checking would be easy.

**`hung`** accepts the connection and then never answers. The port is open. A TCP-level health check
— the kind a cloud load balancer offers by default — would see an open port and call this healthy
forever. Even with an HTTP check it takes measurably longer, because every probe must sit through
its own 250 ms timeout before it counts as a failure. **The probe timeout, not the check itself, is
what detects a hang.**

**`error`** is the one that should worry you. Every real request returns a 500, and `/readyz` returns
200 to every probe, cheerfully, forever. The instance is completely broken and completely healthy by
its own account. No amount of probing finds it, because the probe is not asking the question that
matters.

---

## Which is why passive health checking exists

Run the same `error` fault in **Tab 7 · Failure**, under real traffic, and it *is* caught — costing
about 2% of requests before the balancer removes it.

The difference is that the balancer is not only asking. It is also watching what real requests do,
and three consecutive genuine failures eject a backend that every probe says is fine.

| | Active probes | Passive observation |
|---|---|---|
| Finds | A backend that stopped answering | A backend that answers wrongly |
| Costs | Probe traffic, always | Failed user requests |
| Works when | There is no traffic | There is traffic |

You want both, and for complementary reasons. Active probing finds a dead backend at three in the
morning when nobody is using the service. Passive observation finds the zombie from Lesson 04, which
no probe will ever catch.

---

## The healthy-but-useless case, and how to design against it

Course 2's bug generalises: **a check that can pass while the service cannot do its job is worse
than no check, because it produces confidence.**

The fix there was a sentinel — a table written by the very last statement of the seed, so its
existence proves everything before it finished. This course's database uses the same trick, and you
can see it in `labs/db/init/02-seed.sql`.

The general rule: a readiness check should exercise something that is only true when the service is
genuinely ready. Not "the process is up". Not "the config parsed". Something that would be false if
the work could not be done.

And it should be **cheap and constant-time**. A readiness endpoint that runs a real query gets called
every few seconds by every balancer, and under load that is a surprising amount of database traffic
for a question you are asking about yourself.

---

## What to check, and what never to

Worth writing on a wall somewhere:

- **Do** check that this instance has finished starting, is not draining, and has whatever local
  resources it needs.
- **Do not** check anything shared. Not the database, not the cache, not another service. Lesson 06
  is entirely about what happens when you do.
- **Do not** make readiness expensive. It runs constantly.
- **Do** make liveness the shallowest thing you can write, and treat every liveness failure as "this
  process must die", because that is what it will cause.
- **Do** keep a deep check that tests your dependencies — and point your *monitoring* at it, where a
  human reads the result, not the loop that decides where the next request goes.

That last one is the distinction people miss. Deep checks are genuinely useful. They just belong in
a dashboard, not in a control loop with the authority to remove your entire fleet.

---

## What you should now be able to do

- [ ] Distinguish liveness, readiness and startup, and say what each failure should trigger.
- [ ] Explain why a liveness probe that checks the database causes restart storms.
- [ ] Explain why a TCP health check cannot detect a hung service.
- [ ] Explain why detecting a hang takes longer than detecting a refused connection.
- [ ] Describe a fault that no probe can find, and say what does find it.
- [ ] State the rule for what a readiness check should and should not touch.
- [ ] Explain why a check that can pass while the service is useless is worse than none.

**Artifact for this module:** a **health check specification** for one real service. One line per
endpoint — liveness, readiness, and a deep check if you have one — saying exactly what each does and
does not touch, what timeout and threshold it uses, and what acts on the result. Then find your
service's current health endpoint and answer: could it return 200 while the service was unable to
serve a real request? If yes, describe the fault that would do it. If you genuinely cannot think of
one, you have either designed it well or not looked hard enough, and writing down which is the point
of the exercise.

Next: [06 · Failure, ejection and recovery](06-failure-ejection-recovery.md)
