# 02 · Vertical scaling, and its four ceilings

Course 2 ended its scaling lesson with a line worth taking seriously: *buy a bigger machine — this
is genuinely underrated, vertical scaling is cheap compared to an engineer-year.* That was said
about a database, where it is very nearly always right.

This lesson puts the same claim on a bench at the application tier, where it is right up to a point
and then stops being right rather abruptly. The useful thing is knowing where the point is, and
that it is not one point but four.

---

## What a bigger box actually gives you

Vertical scaling means giving one machine more: more cores, more memory, faster storage, more
memory bandwidth. Your process does not automatically use any of it.

A Node process runs your JavaScript on **one thread**. Put it on a 32-core machine and it will use
one core, politely, while thirty-one sit idle. The way you actually spend those cores is the
`cluster` module, which is about ten lines:

```js
if (cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i++) cluster.fork();
} else {
  server.listen(PORT);
}
```

The primary forks N worker processes, they share one listening socket, and the operating system
hands each accepted connection to one of them. Same box, same port, more cores in play. Every
runtime has its version of this — worker processes in Python, threads in Java and Go, `prefork` in
Ruby. The shape is the same and so are the limits.

You can read the whole of it in `labs/fleet/instance.js`.

---

## The measurement

Open **Tab 2 · Vertical** and run the sweep in `cpu` mode. It restarts the instance at each point
with a different worker count and drives the same load at it. On the machine this was written on,
where only four cores were free for the fleet:

```
workers    rps      speedup   efficiency
   1      96.92      1.00×       100%
   2     158.53      1.64×        82%
   3     234.90      2.42×        81%
   4     273.71      2.82×        70%
```

Read the last column. Every worker you add returns less than the one before it. Four workers did
not do four times the work; they did 2.82 times the work, and the fourth one contributed about half
of what the first one did.

This is the shape you should expect, and expecting it is most of the lesson. **Nobody gets linear
scaling.** The interesting question is never "will it scale?" but "how fast does the efficiency
column fall, and where does it stop being worth paying for?"

Run the sweep again in `io:query` mode and the curve looks completely different — almost flat,
because the work was never CPU-bound and extra workers had nothing to do. Which is Lesson 03.

---

## Ceiling one: you run out of cores

The obvious one, and the only one most people plan for. Once every core is busy, another worker is
another process competing for the same silicon. Throughput stops; context switching goes up.

Two things make this arrive earlier than the core count suggests.

**Your measuring tools need cores too.** The lab reserves some for the load driver, the balancer and
the operating system, and prints the budget it is working with. That is not lab tidiness — it is
true of production. Your metrics agent, log shipper and sidecar proxy are all real processes on the
same machine, and none of them serve traffic.

**Not all cores are equal.** Modern laptop and desktop chips mix a few fast performance cores with
more, slower efficiency cores. Node cannot tell them apart — `os.cpus()` on the machine used here
reports all 32 at an identical clock speed, which is simply not true. So the lab does not claim to
know which is which. It charts per-worker throughput and lets the spread speak: if identical
processes doing identical work achieve visibly different rates, you have learned something real
without having to trust a specification sheet.

---

## Ceiling two: the event loop is still one thread

Clustering gives you N event loops. It does not make any single one of them faster.

If one request does 200 ms of synchronous work — a big JSON parse, a synchronous crypto call, a
regular expression that backtracks — then for those 200 ms that worker answers nobody. Not slowly:
**not at all.** Every other request assigned to it waits, including the health check.

This is why a p99 can be dreadful while a p50 looks fine, and it is why "we added more workers and
the tail got worse" is a real report. More workers means more places for a blocking call to hide.

The fix is never more workers. It is to stop blocking: move the work to a worker thread, break it
into chunks, or do it somewhere else entirely.

---

## Ceiling three: memory, and how it fails

Each worker is a full process with its own heap. Eight workers is eight copies of your code, your
caches, your connection pools. The lab caps each instance at 128 MB deliberately, so a leak becomes
a crash you can see.

The dangerous failure is not running out of memory. It is **paging** — the machine starts swapping,
every latency number becomes a disk measurement, and it looks exactly like a scaling limit. You
will spend a day tuning concurrency before noticing that free memory went to nothing.

That is why the lab checks free memory before it starts a fleet and refuses rather than producing a
plausible, wrong number.

---

## Ceiling four: it is still one machine

The other three are about performance. This one is not, and it is the reason the whole rest of this
course exists.

A vertically scaled service on one box has one power supply, one kernel, one network card, one
operating system to patch, and one deploy that either works or takes everything down. No amount of
cores changes any of that. **Availability is not a performance property, and vertical scaling has no
answer to it at all.**

This is the honest case for running more than one machine, and it holds regardless of what the
throughput numbers say — which turns out to matter more than you would expect, as Lesson 03 shows.

---

## A detail that will bite you: who gets the connection

When workers share a listening socket, something has to decide which one accepts each connection.
Node has two strategies, and the default is not the same everywhere:

| Policy | Who decides | Where it is the default |
|---|---|---|
| `SCHED_RR` | The primary process round-robins | Linux, macOS |
| `SCHED_NONE` | The OS wakes whichever worker it likes | Windows |

On Windows the operating system decides, and it is historically lopsided — some workers get far more
than their share. On Node 24 on Windows, `cluster.schedulingPolicy` reports `SCHED_NONE`.

So the lab charts per-worker request counts rather than assuming they are even. **In-process load
balancing is still load balancing**, it is just done by something you did not configure and cannot
see. If your workers are unevenly loaded and you have been staring at your load balancer, this is
where to look next.

---

## When vertical scaling is the right answer

It very often is, and this course would be dishonest not to say so:

- **It is enormously cheaper than an engineer.** Doubling an instance size is a config change. Making
  a service horizontally scalable can be a quarter of work, and Lesson 03 is about why.
- **It has no distributed-systems tax.** No sticky sessions, no shared cache, no coordination, no new
  failure modes. Everything is still in one process, where it is easy to reason about.
- **Databases in particular scale up beautifully**, which is Course 2's point and remains true.

The trap is not choosing it. The trap is choosing it *without measuring the efficiency column*, then
doubling the instance size again when it stops helping, and paying twice for something that returned
70% the first time and will return less the second.

---

## What you should now be able to do

- [ ] Explain why a single Node process uses one core, and what `cluster` changes about that.
- [ ] Read a scaling curve's efficiency column and say where extra capacity stopped paying.
- [ ] Name the four ceilings and say which of them more cores cannot fix.
- [ ] Explain why one blocking call makes p99 worse as you add workers, not better.
- [ ] Recognise paging as the failure that impersonates a scaling limit.
- [ ] Say why worker request counts may be uneven, and on which platform to expect it.

**Artifact for this module:** a **vertical scaling record** for one real service. Measure throughput
at one worker and at as many as the machine will take, and write down the efficiency at each step.
Then answer two questions in writing: at what size does the next increment stop being worth its
cost, and which of the four ceilings did you actually hit? If the curve is flat from the first
point, say so — that is not a failed experiment, it is Lesson 03 arriving early.

Next: [03 · Horizontal scaling, and the statelessness tax](03-horizontal-scaling.md)
