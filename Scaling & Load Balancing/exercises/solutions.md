# Worked solutions

Read these after attempting the exercise. Every number here came from the lab as shipped, on a
32-core Windows machine where WSL2 had claimed 24 of those cores and the fleet budget was therefore
4. Yours will differ — often substantially — but the *shapes* should match. Where they do not, that
is worth chasing: a curve that differs from these is telling you something about your machine.

---

## 1 · Establish your own numbers

There is no single right answer, only your machine's. The reference run reported:

```
logical cores      32   (24 claimed by WSL2, so 4 available to the fleet)
work unit          13.68 ms   =  ~17,000 SHA-256 rounds
timer floor        20 ms      (a 5 ms sleep actually took 8-15 ms)
driver ceiling     24,995 rps, with 0.04% spread between repeats
```

**The sentence that matters.** Every later measurement is a comparison, and a comparison is only
meaningful against a known noise floor and a known instrument ceiling. If your driver tops out at
25,000 rps, a measurement at 20,000 is describing the driver. If repeats of the same run differ by
15%, a 10% "improvement" is nothing.

**The timer floor is the surprise.** On Windows the default timer resolution is about 15.6 ms, and
any process can change it globally — Chrome does. So the accuracy of your benchmark depends on
whether a browser happens to be open. The lab clamps requested waits to a measured floor rather than
silently running a different experiment than the one you asked for.

---

## 2 · Find the plateau, and disprove the obvious fix

```
concurrency    rps      p50        p99
  1          63.58    57.9 ms    103.3 ms
  8          55.89   124.9 ms    285.3 ms
 64          60.76  1112.5 ms   1301.0 ms
```

Throughput moved by less than the noise floor across a sixty-four-fold increase in concurrency. p99
went up 12.6×.

**Little's Law check.** At concurrency 64 and 60.76 rps:

```
response time = concurrency ÷ throughput = 64 ÷ 60.76 = 1.053 s
measured p50                             = 1.113 s
```

Within 6%, and the remainder is the difference between a mean and a median on a skewed distribution.
The law is not a model that approximately fits — it is a definition rearranged, so it cannot be
wrong; if your numbers disagree badly, one of them is measured incorrectly.

**Adding threads.** Zero. Throughput is fixed by one core doing 13.68 ms of work at a time. Every
extra thread becomes queue, and Little's Law says exactly how much: latency rises in direct
proportion.

---

## 3 · Break a load test on purpose

```
offered 200 rps      closed loop p99     367 ms
                     open loop   p99  16,223 ms      44×
```

The closed loop holds a fixed number of requests in flight. When the server slows, the client sends
more slowly — so the backlog real traffic would create never forms. It is not measuring a faster
server; it has stopped asking.

**Where they agree.** Below capacity. At an offered rate comfortably under the plateau, nothing
queues in either mode and the two report the same p99. The divergence begins at the plateau and
grows without limit above it, because in an open loop the backlog grows for the whole run.

**Detecting it in someone else's tool.** Two questions. Does it let you specify an *arrival rate*
rather than only a thread or connection count? And does it record the intended start time before
dispatch? A tool configured only in "threads" or "virtual users" is closed-loop, and its tail
latency is optimistic by an amount that grows precisely when it matters.

---

## 4 · The control experiment, run yourself

```
work        4 instances    1 instance    ratio
io:query     5,383 rps     7,838 rps     0.69
cpu            243 rps        99 rps     2.46
```

**Why one process kept up.** An I/O-bound request spends nearly all its time waiting, during which
the event loop is free. One process holds hundreds in flight. The fleet did not add capacity that
was missing — it added a proxy hop in front of work that was already nearly free, and here the hop
cost more than the parallelism returned.

**The pool is the real variable.** Raise `POOL_SIZE` in `labs/db/pool.js` and the single instance
improves; lower it and the fleet looks better by comparison. That is the demonstration: what changed
throughput was concurrency at the dependency, which you can buy from one process.

**Three reasons that survive.** Availability — one box has one kernel and one power supply.
Deployability — with one instance every release is an outage. Blast radius — a leak or a bad config
affects a quarter of requests instead of all of them. None is a throughput argument and none is
weakened by the table above.

---

## 5 · Make a policy matter

```
all healthy      every policy within ~2% of even, no meaningful difference

one slow         policy          rps    to the slow instance
                 round-robin  164.59          26.72%
                 least-conn   200.98           6.36%
                 p2c          208.85           7.70%
```

Round robin has no feedback signal at all, so it keeps sending a full share into a backend taking
300 ms. Least connections needs no configuration to notice: a slow backend accumulates in-flight
requests, and the policy simply stops choosing it.

**Which to deploy.** Least connections or power-of-two for anything where backends can differ —
which is everything, because they always eventually do. Power-of-two if the pool is large enough
that scanning it per request matters.

**When you would regret it.** Exercise 6.

**Stretch — random.** Random lands very close to round robin: it sends the slow backend its fair
share, because it also has no feedback. It is slightly worse than round robin on evenness for small
samples and slightly better under concurrency, since round robin's cursor can synchronise with
request patterns. The useful insight is that *random and round robin are in the same family* — no
signal — while least-conn and p2c are in another.

---

## 6 · Walk into the black hole

```
fair share would be 25%

round-robin          24.53%
p2c                  48.72%
least-conn           98.41%
```

The zombie returns a 500 in well under a millisecond. It therefore has, at every instant, the fewest
in-flight requests of any backend — because it never holds one. Least connections is not
malfunctioning; it is faithfully following a signal that has become a lie. **Failing fast is
indistinguishable from being idle.**

P2C sits in between for a structural reason: it only compares two backends at a time, so the zombie
wins only the comparisons it happens to be sampled into. It is dragged toward the hole but not all
the way in.

**With health checking on**, the zombie is ejected in about 1.5 seconds by passive observation — the
balancer counts real request failures, not just probes. The damage is bounded by the detection floor
rather than by the policy.

**The fix to least-conn.** Weight each backend by recent success rate as well as in-flight count, so
that a backend failing everything scores badly no matter how idle it looks. The cost is state — you
now need a rolling window of outcomes per backend — and a tuning decision about the window length,
which is a trade between reacting quickly and reacting to noise. This is roughly what Envoy's
outlier detection does.

---

## 7 · Time every kind of failure

```
fault      detected in   probe reported
dead          1063 ms    ECONNREFUSED
unready       1357 ms    status 503
hung          1708 ms    timeout
error            never   (every probe passed)
```

**Why they differ.** `dead` closes its listener, so each probe fails in microseconds and only the
check interval limits detection — 1,063 ms against a 1,500 ms floor because the first probe landed
mid-interval. `unready` answers immediately with a 503, so it is nearly as fast. `hung` accepts the
connection and never replies, so *every probe must sit out its full 250 ms timeout* before counting,
which is where the extra time goes.

**What a TCP check misses.** `hung` completely — the port is open. And `error` and `unready`, since
both accept connections happily. A TCP health check verifies that something is listening, which is
almost never the question you meant to ask.

**The undetectable one.** `error` returns 200 to `/readyz` and 500 to `/work`. No probe interval
finds it, because the probe is asking a different question from the one that matters. Passive
health checking catches it under real traffic, at a cost of about 2% of requests.

**Changing `timeoutMs`.** It moves `hung` and nothing else. Halving it to 125 ms takes roughly 375 ms
off the detection time; raising it to 1,000 ms adds about 2.2 seconds. The others never wait for the
timeout, so they do not move at all — which is the cleanest possible demonstration that the probe
timeout is what detects a hang.

---

## 8 · Cause an outage with a health check

```
deep check, dependency down                    2 of 4 healthy    panic engaged
readiness check, same dependency still down    4 of 4 healthy
```

Nothing about the dependency changed between those two lines. The health check was asked a different
question, and the fleet came back.

**What caused the outage.** The health check. Every instance depended on the same thing, so they all
failed simultaneously, and a balancer that believed them removed the entire fleet — including for
requests that never needed the dependency at all. A partial degradation became a total outage.

**What the panic threshold prevented.** It refused to eject past half the pool, so two instances kept
serving. Without it the count reaches zero and every request returns 503. Set `panicThreshold: 0` in
`labs/lb/health.js` and you can watch exactly that happen.

**Reproducing it by hand.** Set the checker dropdown to `/deepz`, then use each instance's dropdown
to inject `deep-fail`. The cascade button just automates it. Doing it manually is worth the two
minutes because you watch the fleet drain one instance at a time.

---

## 9 · Price statelessness

```
in-memory sessions, round robin    75.35% of follow-ups hit the wrong instance
                                   theoretical (n-1)/n = 75%

sticky, lose one instance of 4     modulo hash      74.4% of keys move
                                   consistent ring  26.1%
                                   ideal (1/n)      25%

shared store                       1.98 ms p50, 8.49 ms p99 per request
```

**Deriving the first.** A follow-up request lands on a uniformly chosen instance. It matches the
user's home instance with probability 1/n, so it misses with probability (n−1)/n. At n=4 that is
75%. The measurement is 75.35% because the sample is finite.

**The geometry of the second.** Under `hash % n`, changing `n` changes the divisor and therefore the
result for nearly every key. A ring instead places instances at fixed points on a circle and assigns
each key to the next instance clockwise. Removing one instance only affects keys in *its* arcs —
everything else still finds the same neighbour it always did. That is why the fraction that moves is
1/n rather than (n−1)/n.

**Virtual nodes.** Drop the count in `buildRing()` from 150 to 1 and load skew becomes severe — with
one point per instance the arcs are wildly unequal. Raise it to 500 and skew improves slightly while
memory and lookup cost rise. Around 100–200 is the usual sweet spot, and the reason virtual nodes
exist at all is that a ring with one point per node balances badly.

---

## 10 · Read someone else's balancer

The hop measurement will be a millisecond or so. It is not nginx being slow — it is the container
crossing a virtual network to reach a process on the host, which the host-native balancer never
pays. Any rps table comparing the two would be a table about Docker's networking.

The mapping table in the tab is the deliverable. The six that matter most:

| nginx | this lab |
|---|---|
| `upstream` / `server` | `setBackends()` |
| `least_conn` | `POLICIES['least-conn']` |
| `max_fails=3` | `ejectAfter: 3` |
| `fail_timeout=5s` | `probeAfterMs: 5000` |
| `proxy_next_upstream` | the retry branch in `proxy()` |
| `proxy_read_timeout` | `upstream.setTimeout(5000)` |

**No active health check.** Open-source nginx learns a backend is bad by sending it a real request
and watching that fail. There is no probe traffic at all, which is elegant — and the detection cost
lands on users instead. Active checks are an nginx Plus feature, and so is `slow_start`. Both are
worth noticing: putting a backend in the pool is free, and putting it back *without immediately
re-breaking it* is the part somebody charges for.

---

## 11 · The course artifact

No worked solution — it is about *your* system. Three failure modes to avoid:

**Numbers from the internet.** "A Node service handles about 10,000 rps" is not a capacity
measurement, it is a rumour with a decimal point. The number must come from your service, on your
hardware, with your requests.

**A plan with no trigger.** If nothing in the document says when to revisit it, it is a snapshot, and
it will be quietly wrong within two quarters without anybody noticing.

**Scaling the tier that was not the problem.** If you cannot name the resource that ran out, the plan
is a guess. That is what Lesson 03's control experiment exists to guard against, and it is the most
expensive mistake on this list.
