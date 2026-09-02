# 01 · What "it is slow" actually means

In Course 2 you fixed the queries. You found the missing index, you watched the block count fall
from 36,372 to 10, you sized the pool and you learned what a connection costs. And the service can
still fall over at five o'clock on a Tuesday, with every query as fast as you left it.

That is not a contradiction. Course 2's lab was one Node process in front of one Postgres, and one
process has one event loop. This course is about the tier above the database, and it starts where
every scaling conversation should start: with what "slow" is actually a measurement of.

---

## Slow is not a property of a request

A request that takes 800 ms is not slow in the way a query is slow. Time it on an idle machine and
it may take 14 ms. Nothing about the code changed between those two numbers. What changed was how
many other people were asking at the same time.

So there are two different quantities, and confusing them is the root of most bad capacity
decisions:

| Quantity | What it is | Changes when |
|---|---|---|
| **Service time** | How long the work takes once it starts | The code or the data changes |
| **Response time** | How long the caller waited | Anything about the load changes |

Course 2 tuned service time. This course is almost entirely about the gap between the two.

---

## Capacity is a rate, and you already own it

Open **Tab 1 · Capacity** and press *Run preflight*. It measures your machine, the size of one unit
of work, your platform's timer resolution and the load generator's own ceiling, and it does that
before it measures a single server. There is a reason for the order, which the tab states plainly:
a benchmark that has not calibrated its own instruments is a rumour.

Then run *Ramp concurrency* in `cpu` mode. One instance, one worker, and concurrency climbing from
1 to 64. Here is what it produced on the machine this was written on:

```
concurrency    rps      p50        p99
  1          63.58    57.9 ms    103.3 ms
  2          49.38    80.2 ms    126.8 ms
  4          52.23    73.9 ms    149.8 ms
  8          55.89   124.9 ms    285.3 ms
 16          61.11   256.5 ms    375.4 ms
 32          58.66   584.6 ms    701.4 ms
 64          60.76  1112.5 ms   1301.0 ms
```

Read the first column downwards. Throughput sits between 49 and 64 requests per second at every
level. Sixty-four times more people asking at once, and the service does not do meaningfully more
work.

Now read the last column. p99 goes from 103 ms to 1,301 ms — **twelve and a half times worse for
exactly the same amount of work delivered.**

That is the whole shape of capacity, and it does not have a knee in it. One worker can burn one
core, one core does about 14 ms of work at a time, and everything above concurrency 1 is people
standing in a queue. The lab says so rather than drawing a curve with an inflection point it does
not have.

---

## Little's Law, which is the only formula in this course

> **Throughput = concurrency ÷ response time.**

Rearrange it and it tells you something uncomfortable: once throughput is fixed, adding concurrency
can *only* increase response time. There is nowhere else for it to go.

Check it against the table. At concurrency 64 and about 61 rps, the law predicts a mean response
time of 64 ÷ 61 ≈ 1.05 seconds. Measured p50 was 1.11 seconds. The arithmetic is not approximately
right; it is right, because it is not a model of anything — it is a definition rearranged.

This is why "just add more threads" is so often a non-fix. Threads are concurrency. If the system
is already at its throughput ceiling, more of them buys latency and calls it work.

**You met this in Course 2, Lesson 07**, at the connection pool: concurrency 8 against a pool of 8
queued for 14 ms at p95, and concurrency 40 against the same pool queued for 213 ms — 81% of the
total latency was waiting for a connection rather than using one. Same arithmetic, one layer down.
The pool was the constrained resource then; the CPU is the constrained resource now. Little's Law
does not care which.

---

## Why p99 detonates rather than drifts

Utilisation is the fraction of capacity you are using. As it approaches 1, waiting time does not
climb steadily — it goes to infinity. For simple queues the mean wait scales with `1 ÷ (1 − ρ)`,
where ρ is utilisation:

```
utilisation   relative wait
  50%             2×
  80%             5×
  90%            10×
  95%            20×
  99%           100×
```

Two consequences worth carrying around for the rest of your career.

**A server at 50% utilisation is not half-loaded, it is comfortable. A server at 90% is not
"efficiently used", it is ten times worse than the one at 50% and one traffic spike from being
useless.** Headroom is not waste; it is the entire reason your latency is stable.

**Averages hide this completely.** The mean of a latency distribution sits in a region where almost
no request actually lands. That is why every measurement in this lab reports p50, p95 and p99, and
why the p99 column is the one that moves.

---

## Closed loop, open loop, and the lie in most load tests

There are two ways to generate load, and almost every simple benchmark uses the first without
saying so.

A **closed loop** holds a fixed number of requests in flight and sends the next one when the last
comes back. It finds maximum throughput accurately. But when the server slows down, *the client
slows down with it* — so the queue that real traffic would have formed never exists.

An **open loop** sends requests on a schedule regardless of whether earlier ones have returned,
which is how your users behave. They do not wait for each other.

Press *Closed loop vs open loop* in Tab 1. Same instance, same work, the same offered load of
200 requests per second:

```
closed loop    p99     367 ms
open loop      p99  16,223 ms       44× worse
```

Nothing changed on the server between those two runs. The closed loop did not measure a faster
service; it simply stopped asking whenever the service got slow, so the worst moments produced
fewer samples instead of dominating the percentiles.

This is **coordinated omission**, and it is why load-test results are so often cheerfully wrong. The
fix is to record the time a request was *supposed* to depart, before it departs, and measure from
there. The lab does this, and the Health and Failure tabs use the open loop for exactly this reason.

---

## Your instruments have a capacity too

The preflight measured the load generator against an endpoint that does nothing at all:

```
driver ceiling   24,995 rps
spread between repeats  0.04%
```

Any measurement that approaches that number is describing the driver, not the server. The lab marks
runs above 70% of it as instrument-limited and declines to draw a conclusion from them.

Almost no course does this, and it is the difference between a lab and a rumour. Before you believe
any load-test result — yours or a vendor's — the first question is whether the tool could have
produced a bigger number if the server had been faster.

---

## What you should now be able to do

- [ ] Distinguish service time from response time, and say which one an index fixes.
- [ ] State Little's Law and use it to predict response time from throughput and concurrency.
- [ ] Explain why latency at 90% utilisation is roughly ten times worse than at 50%.
- [ ] Explain why adding threads to a saturated service makes it slower, not faster.
- [ ] Describe coordinated omission and how a closed-loop test hides queueing.
- [ ] Say why a load generator must be measured before anything is measured with it.

**Artifact for this module:** a **capacity profile** of one real service you work on. Find its
throughput plateau and the concurrency at which it gets there, and record p50, p95 and p99 at that
point and at twice it. Then write one sentence naming the resource that ran out — cores, a
connection pool, a downstream API, a lock — and one sentence saying what you would have concluded
if you had only looked at the mean. If you cannot get a number, write down what stopped you; "we
have no way to measure this" is itself the finding, and it is a more common one than anybody admits.

Next: [02 · Vertical scaling, and its four ceilings](02-vertical-scaling.md)
