# 03 · Horizontal scaling, and the statelessness tax

Everyone knows what horizontal scaling is for. You run more copies of the service, put a load
balancer in front, and you get more throughput. It is the most repeated claim in system design and
it is the reason people reach for it.

It is also, for a large class of services, false. This lesson measures it, and the measurement is
the reason the rest of the chapter is worth doing.

---

## The experiment that decides what this course may claim

Open **Tab 3 · Horizontal** and press *N instances vs 1 instance, same concurrency*.

It runs the same load twice for each kind of work. Once against a fleet behind the balancer, once
against a single instance — with **identical total request concurrency** both times. The only thing
that changes is how many processes are serving.

```
work        4 instances    1 instance    ratio
io:query     5,383 rps     7,838 rps     0.69
cpu            243 rps        99 rps     2.46
```

Read the first row twice, because it does not say what you expect. For I/O-bound work, one process
beat four. The fleet was **slower**.

---

## Why one process was enough

An I/O-bound request spends nearly all its life waiting — for a database, a cache, another service.
During that wait the event loop is doing nothing at all. It is free to accept the next request, and
the next, and several hundred more.

So a single Node process can hold enormous numbers of I/O-bound requests in flight simultaneously.
It was never the constraint. When you add instances and throughput rises, the causal variable is not
the instance count — it is total concurrency at the dependency, and you could have had that from one
process with a bigger connection pool.

What the fleet added here was a proxy hop in front of work that was already free. The hop is small,
but it is not zero, and when the thing it fronts costs almost nothing the overhead is the whole
difference. Hence 0.69.

The second row is the control. In `cpu` mode the app tier really is the bottleneck — one event loop
can burn one core and the work is nothing but core-burning — so instance count becomes causal and
four instances do 2.46 times the work.

**That inversion is the lesson.** "Scale out for throughput" is true only when the application tier
is what ran out. For a great many services it is not, and the honest answer to "should we add more
instances?" begins with "what is this service actually waiting on?"

---

## So why run more than one at all?

Because throughput was never the good reason. The good reasons survive the measurement above
completely intact:

- **Availability.** One process on one machine has one power supply and one kernel. Lesson 02's
  fourth ceiling has no answer except more machines.
- **Somewhere to deploy.** With one instance, every release is an outage. With four, you replace them
  one at a time and nobody notices.
- **Blast radius.** A memory leak, a bad config push, a poisoned cache — with one instance that is
  everybody. With four it is a quarter of requests, and the balancer takes it out of rotation.
- **Headroom for the spike you did not predict.** Not average throughput — the surge.

These are excellent reasons to run a fleet. Note that not one of them is a performance argument, and
none of them shows up in a throughput benchmark. If you justify a fleet on rps alone, the numbers
may well embarrass you.

---

## The sweep, and what it costs

Run the full instance sweep and compare it against Lesson 02's worker sweep. Same machine, same
total parallelism at every point:

```
                  1        2        3        4     speedup   efficiency
vertical       96.92   158.53   234.90   273.71     2.82×        70%
horizontal    105.18   201.59   220.77   262.93     2.50×        63%
```

Horizontal scaling did slightly worse. That is expected and worth understanding: every request now
crosses a process boundary and a proxy, where before it went straight into the worker. You are
paying for the balancer, and the payment is real.

You buy availability with that difference. The trade is almost always right — but it *is* a trade,
and a course that only showed you the horizontal curve would have hidden the price.

---

## The tax: what has to leave the process first

None of this works until your instances are interchangeable. If a user's second request cannot be
served by a different instance than their first, you do not have a fleet — you have several
single-instance services wearing a trench coat.

Here is what has to move out, in the order it usually bites:

| What | Where it hides | What breaks |
|---|---|---|
| **Sessions** | `req.session` in memory | Users log out at random. Tab 5 measures the rate |
| **In-process caches** | A module-level `Map` | Each instance has a different, stale answer |
| **Uploads and temp files** | Local disk | The follow-up request lands elsewhere and the file is gone |
| **Scheduled jobs** | `setInterval` at module scope | Runs N times instead of once. Nightly billing, N times |
| **Counters and rate limits** | A local integer | Your limit of 100/min is really 100 × N |
| **WebSocket state** | The connection's process | Only that one instance can push to that user |
| **Locks** | A boolean | Not a lock. Never was |

Two of these deserve special attention because they fail silently.

**Scheduled jobs** are the one that gets people. Nothing errors. The job runs, four times, and by the
time you notice the duplicate charges you have been horizontal for six weeks.

**Counters** are the same shape. A rate limiter keeping its count in memory across four instances
enforces four times the limit you configured, and it will pass every test you write on one machine.

Lesson 07 is about the two ways to deal with all of this, and what each one costs.

---

## What this lab cannot show you, and why it matters

Every "instance" here is a process on one machine. They share a kernel, a loopback interface and a
page cache. That is enough to teach distribution honestly — the balancer, the health checks, the
ejection behaviour and the statelessness tax are all real. Several things it cannot teach at all:

- **Network cost.** Loopback is tens of microseconds; a real network hop inside one datacentre is
  one to two milliseconds, and across regions far more. Every latency number here is missing the
  dominant term of a real deployment. *"The extra balancer hop is cheap" is not a conclusion this
  lab can support.*
- **Real failure domains.** Killing a process is not losing a machine. A dead machine takes its
  network card, its page cache and its share of bandwidth with it; here the OS reclaims a process and
  instantly hands its CPU to the survivors — which flatters the fleet.
- **Fault isolation.** An instance pegged at 100% CPU here degrades the balancer, the load generator
  and the database, because they share a machine. In production one bad host does not slow your load
  balancer down.

The *shapes* transfer: the knee, the queue growth past capacity, the ejection oscillation, the
reshuffle fraction. The absolute numbers transfer to nothing at all.

---

## What you should now be able to do

- [ ] Explain why one process can hold hundreds of I/O-bound requests in flight.
- [ ] Describe the control experiment, and say what it proves about instance count.
- [ ] Give three reasons to run a fleet that are not about throughput.
- [ ] Name what horizontal scaling costs relative to vertical, and where that cost comes from.
- [ ] List the things that must leave a process before instances are interchangeable.
- [ ] Explain why an in-memory rate limiter is wrong by a factor of N, and why tests miss it.
- [ ] State one thing this lab cannot demonstrate, and why.

**Artifact for this module:** a **statelessness inventory** for one real service. Go through the
table above against your own code and write down, for each row, either where that state lives now or
"we do not have any". For every item that is in-process, note what would actually break if the next
request landed elsewhere and how you would find out — an error, a support ticket, or never. The
value here is entirely in the honesty: an inventory that says "sessions: Redis, cache: in-process
and we know it, jobs: still on a `setInterval` and we have been lucky" is worth ten times a clean
one that was not really checked.

Next: [04 · The load balancer](04-the-load-balancer.md)
