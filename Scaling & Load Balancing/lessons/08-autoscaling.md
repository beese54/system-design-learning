# 08 · Autoscaling, and what to scale on

Autoscaling is a control loop: watch a signal, compare it to a target, add or remove instances. The
mechanism is simple enough that every cloud provider gives it to you in a form field, which is
precisely why it is so often configured wrongly.

Everything that makes it hard is in the three questions the form does not ask. What signal? How
fast? And what does being wrong cost in each direction?

---

## Scaling on CPU is the default and it is usually wrong

The default is average CPU across the fleet, with a target around 70%. It is the default because it
is the easiest thing to measure, not because it is the right signal.

Lesson 03 is why. For an I/O-bound service the CPU is nearly idle while every request waits on a
database — you can be completely saturated, with users timing out, at 15% CPU. The autoscaler sees a
comfortable number and does nothing. Meanwhile a service that briefly compiles a template spikes to
90% and gets scaled out for a workload that did not need it.

**Scale on the thing that runs out, and it is only sometimes the CPU.**

| Signal | Good for | Fails when |
|---|---|---|
| CPU | Genuinely CPU-bound work | Anything I/O-bound; saturates at 15% CPU |
| Request rate | Predictable per-request cost | Requests vary wildly in cost |
| Latency (p99) | Direct proxy for user pain | Lags; already bad by the time it moves |
| **Queue depth** | Almost everything | Needs a queue you can see |
| Concurrent requests | Anything with a bounded pool | Needs instrumentation you may not have |

Queue depth is the best general answer and it is worth understanding why. A queue is the *only*
signal that tells you demand exceeds capacity regardless of what the resource is. If work is
arriving faster than it leaves, the queue grows — and that is true whether the bottleneck is CPU,
a connection pool, a downstream API or a lock. Everything else is a proxy for it.

If you have no explicit queue, in-flight request count is the closest thing you own.

---

## Little's Law, again, doing the arithmetic

You already have the tool for capacity planning. From Lesson 01:

> instances needed = (arrival rate × response time) ÷ concurrency each instance can handle

Take the numbers from your own capacity profile. If one instance plateaus around 60 rps and you
expect 500 rps at peak, you need nine instances to serve it — and you do not want nine, because nine
instances at 100% utilisation gives you the latency at the far right of Lesson 01's table.

At 70% utilisation you need thirteen. At 50%, eighteen. **The headroom is not waste; it is what you
are buying when you buy stable latency**, and the utilisation curve means the last 20% is
disproportionately expensive in latency terms.

That is the whole calculation. The hard part is not the arithmetic; it is having a measured
plateau to put into it, which is why Lesson 01's artifact came first.

---

## Warm-up, cooldown, and the oscillator

A new instance is not useful the moment it exists. It has to boot, start, warm its caches, fill its
connection pool and get its JIT going — and Lesson 06's slow-start ramp exists because handing it a
full share before then simply breaks it again.

So there is a delay between deciding to scale and getting capacity. That delay is what makes the
control loop hard, and it produces the classic failure:

```
load rises  ->  scale out  ->  instances take 90s to be useful
            ->  metric still bad  ->  scale out again
            ->  first batch arrives, metric collapses
            ->  scale in hard  ->  load still there  ->  scale out again
```

You have built an oscillator, and it costs money at every swing. The defences are all about damping:

- **Cooldown.** Do nothing for a period after acting, so the last change can take effect.
- **Asymmetric thresholds.** Scale out fast, scale in slowly. The cost of being one instance short is
  a user-visible outage; the cost of being one instance over is a few pounds. These are not
  comparable and the configuration should not treat them as if they were.
- **Scale-in stabilisation.** Require the low reading to persist for several minutes.
- **A floor.** Never scale below the number that can absorb a sudden spike while new capacity boots.

---

## The thing autoscaling cannot do

It cannot react to a spike faster than your instances can start.

If traffic goes up tenfold in ten seconds and an instance takes ninety seconds to be useful, you
will be down for eighty seconds no matter how good the policy is. Reactive autoscaling handles
*trends*; it does not handle *spikes*.

Which is why the real answers to spikes are different things entirely: keeping enough headroom to
absorb them, scheduled scaling when the spike is predictable (and most are — the sale starts at 9am,
the batch job runs at midnight), a queue to absorb the burst and flatten it into a rate, and load
shedding when all of that is exhausted.

**Shedding deserves more respect than it gets.** A service that returns a fast, clear 503 to 20% of
requests when it is over capacity is behaving correctly. A service that accepts everything and
queues it until every user gets a thirty-second timeout has converted a partial outage into a total
one. Lesson 01's table is the argument: past the plateau, accepting more work does not produce more
throughput, it only produces more waiting.

---

## What it costs to be wrong, in each direction

Worth writing down explicitly, because the two are treated as symmetric by almost every default
configuration and they are nothing alike:

| | Too few instances | Too many |
|---|---|---|
| Immediate effect | Latency climbs, requests fail | A larger bill |
| Who notices | Users, immediately | Finance, next month |
| How fast recoverable | As fast as instances boot | Instantly |
| Worst case | Cascading failure, retry storms | You spent some money |

Being over-provisioned is a cost. Being under-provisioned is an outage. Configure accordingly, and
be suspicious of any autoscaling policy that scales in as eagerly as it scales out.

---

## What you should now be able to do

- [ ] Explain why CPU is the wrong scaling signal for an I/O-bound service.
- [ ] Say why queue depth is the most general signal, and what to use if you have no queue.
- [ ] Use Little's Law to size a fleet from an arrival rate and a measured plateau.
- [ ] Explain why the utilisation target matters as much as the instance count.
- [ ] Describe the oscillation failure and name three ways to damp it.
- [ ] Explain why autoscaling cannot handle a spike, and what does.
- [ ] Argue why load shedding is correct behaviour rather than giving up.

**Artifact for this module:** a **capacity plan** for one real service, on one page. Its measured
throughput plateau per instance (from Lesson 01's artifact), its peak arrival rate, the utilisation
target you are choosing and why, and the resulting instance count. Then name the signal you would
scale on and the threshold, with one sentence saying why that signal and not CPU. Finish with the
two costs written explicitly: what one instance too few costs you, and what one too many costs you.
If those two numbers are not wildly different, check them again — they almost always are.

Next: [09 · What does not scale horizontally](09-what-doesnt-scale.md)
