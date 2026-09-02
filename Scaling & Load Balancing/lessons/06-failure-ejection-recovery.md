# 06 · Failure, ejection and recovery

Detecting a broken backend is the easy half. What the balancer does next — how fast it removes it,
how long it waits, how it decides to trust it again, and whether it is willing to remove all of them
— is where health checking turns from a good idea into an outage or away from one.

This lesson is about the state machine, and about the specific way a well-intentioned health check
turns a degraded service into a dead one.

---

## The state machine

Every parameter in `labs/lb/health.js` is a decision with a cost. The defaults are close to what
nginx and Envoy ship:

```
healthy  --(3 consecutive failures)-->  ejected
ejected  --(5s fail timeout elapsed)-->  probing
probing  --(2 consecutive passes)-->    healthy, at a ramped weight
```

| Parameter | Default | The trade |
|---|---|---|
| `intervalMs` | 500 | Faster detection, more probe traffic |
| `timeoutMs` | 250 | Too low ejects slow-but-working backends |
| `ejectAfter` | 3 | 1 ejects on any blip; 3 costs 1.5 s |
| `restoreAfter` | 2 | Quick to remove, slow to trust |
| `probeAfterMs` | 5000 | How long an ejected backend stays out |
| `rampMs` | 10000 | How gradually a recovered backend returns |
| `panicThreshold` | 0.5 | Never eject more than half the fleet |

Notice that `ejectAfter` and `restoreAfter` are deliberately different. **That asymmetry is
hysteresis**, and it is the entire defence against a flapping backend oscillating in and out of the
pool. Quick to remove, slow to trust.

---

## The error budget you cannot avoid

Open **Tab 7 · Failure**, set retry to *off*, and break an instance under constant load.

Errors do not begin the instant the instance breaks — some requests were already in flight. And they
do not stop the instant it is detected — the balancer keeps sending to it right up until it ejects.
The window between is your error budget, and its size is set by your parameters, not by the fault:

```
detection floor = intervalMs × ejectAfter = 500 × 3 = 1500 ms
```

At 120 requests per second across four instances, roughly a quarter of traffic is going to the
broken one, so a 1.5 second window costs on the order of forty failed requests. Halving the interval
halves that and doubles your probe traffic. **There is no setting that makes this zero.** There is
only a choice about where to spend.

Now turn retry *on* and run it again. The error rate collapses to nearly nothing: the balancer
quietly resends each failure to a healthy backend and nobody outside ever learns anything happened.
Retry is the single most effective thing here — and it is doing work twice, so a fleet already near
capacity can retry itself into a worse outage than the one it was hiding.

---

## Recovery is the half people forget

A backend that comes back is not ready to take a full share. Its caches are cold, its JIT is
unwarmed, its connection pool is empty. Give it 25% of your traffic the instant it returns and it
will fail again — and you have built an oscillator, where the instance is ejected, recovers, is
overwhelmed, and is ejected again forever.

Slow start is the fix. The weight climbs linearly and the balancer picks the instance in proportion:

```
t+0s   weight 0.05
t+2s   weight 0.21
t+4s   weight 0.41
t+6s   weight 0.61
t+8s   weight 0.81
t+10s  weight 1.00
```

Watch it in the fleet board after reviving an instance. In nginx this is `slow_start`, and it is
notably a commercial feature — which tells you something. Putting a backend back in the pool is
free; putting it back without immediately re-breaking it is the part somebody charges for.

---

## The cascade, which is the most valuable thing in this chapter

Here is a health check that sounds more responsible than the one you have:

```
GET /readyz -> also verify we can reach the database
```

It is thorough. It only reports ready when the instance can actually serve a request end to end.
Every instinct says this is better.

Press *Run the cascade*. It points the checker at `/deepz`, breaks the shared dependency for every
instance at once, and then does the same thing again with readiness pointed back at local state:

```
deep check, dependency down                    2 of 4 healthy    panic engaged
readiness check, same dependency still down    4 of 4 healthy
```

Read that twice. **Nothing about the dependency changed between those two lines.** The only
difference is what the health check was asked.

With deep checks, every instance fails at the same instant — because they all depend on the same
thing — and a balancer that believes them removes the entire fleet. Requests that did not need the
database, that those instances could have served perfectly, now get nothing. A degraded service
became a total outage, and **the outage was caused by the health check, not by the fault.**

This is a real and common production incident. A database has a slow minute; every service's
readiness probe times out; the orchestrator removes every pod; the load balancer has nothing to send
to; the one-minute blip becomes a twenty-minute outage while everything restarts.

Two defences, and you want both.

**Readiness must depend only on local state.** A dependency being down is not a reason to remove a
working process from rotation. It is a reason to serve degraded responses — a cached answer, a
partial page, a clear error — from a process that is still running.

**The balancer needs a panic threshold.** When more than half the pool fails at once, the cause is
almost certainly shared: a dependency, a bad config push, or the check itself. Envoy's rule is to
stop ejecting and send traffic to everything, on the reasoning that possibly-working backends beat
no backends. You can see it in the first line above: it would have ejected all four and it refused,
holding at two.

---

## Draining, which is the failure you choose

Every failure so far has been involuntary. But most instances leave a fleet on purpose — a deploy, a
scale-down, a node being replaced — and doing that badly produces exactly the same errors as a crash
for no reason at all.

The order matters and it is the whole lesson: **stop receiving traffic before you stop accepting
it.**

1. Mark yourself not-ready, so the balancer stops choosing you.
2. Wait long enough for it to notice — at least one check interval.
3. Stop accepting new connections; finish the ones in flight.
4. Exit.

Skip step 2 and the balancer sends requests to a process that has already closed its listener, which
is an outage you scheduled.

On Linux an orchestrator sends `SIGTERM` and gives you a grace period to do this. **On Windows there
is no such contract** — `kill()` terminates the process immediately whatever signal name you pass,
so the drain has to be requested at the application layer. The lab does it over its IPC channel, and
you can watch the difference between `drain` and `kill` in the supervisor.

---

## What you should now be able to do

- [ ] Explain what hysteresis is in this context and which two parameters create it.
- [ ] Calculate the detection floor from the check interval and the failure threshold.
- [ ] Explain why the error budget during a failure cannot be reduced to zero.
- [ ] Say what retry buys and what it costs a saturated fleet.
- [ ] Explain why a recovered instance needs a ramp, and what happens without one.
- [ ] Describe the deep-check cascade and name the two defences against it.
- [ ] Give the correct order of operations for draining an instance, and say why.

**Artifact for this module:** an **ejection and recovery transcript**. Break one backend under load
and record, with timings: when it broke, when the balancer noticed, how many requests failed in
between, when it was probed again, and how long until it carried a full share. Then find your own
system's numbers — check interval, failure threshold, and whether it has a panic threshold at all.
If your readiness check touches a shared dependency, write down what would happen to every instance
if that dependency had a bad minute. An argument that a cascade is possible is a hypothesis; a
transcript is evidence.

Next: [07 · Sessions and stickiness](07-sessions-and-stickiness.md)
