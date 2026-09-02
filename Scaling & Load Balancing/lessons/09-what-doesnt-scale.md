# 09 · What does not scale horizontally

The application tier is the easy part. That is the uncomfortable conclusion of this course: once
state has left the process, adding instances is a configuration change, and the whole apparatus of
balancers and health checks is well-understood machinery you can buy.

Everything hard is somewhere else. This lesson is a list of the somewhere elses, so that you
recognise them before you spend a quarter scaling the tier that was never the problem.

---

## The database, which Course 2 already covered

The obvious one, and you have done it. `Data & Storage`, Lesson 08 is the whole answer: vacuum and
bloat, partitioning, the four settings that matter, read replicas and their lag, and sharding as the
one-way door you take last.

Two things are worth carrying forward into this course's context.

**Read replicas scale reads and do nothing for writes.** Every replica replays every write. If your
problem is write throughput, replicas add hardware and solve nothing.

**Your stateless fleet made the database problem worse.** Lesson 07 moved sessions into the shared
store, which put it on the critical path of every request in the fleet. Lesson 03's fleet multiplied
the connections arriving at it — eight instances with a pool of five each is forty backends, and
Course 2 Lesson 07 explains what that costs. Scaling out the app tier applies pressure downward, and
the database is where it lands.

---

## The balancer itself

You spent this course putting a proxy in front of everything. That proxy is now a process every
request passes through, with a throughput ceiling of its own and a single point of failure written
all over it.

The lab measures its own driver ceiling for exactly this reason; a balancer has one too. And the
answers to a balancer that has become the bottleneck are all outside the balancer:

- **DNS round robin** — hand out several addresses. Free, and crude: DNS caches ignore your TTLs and
  clients do not fail over quickly.
- **Anycast** — the same address announced from many places, with the network choosing. Excellent,
  and it needs to be your network.
- **A pair with a floating address** — active/passive with a virtual IP. The standard on-premises
  answer.
- **Client-side balancing** — the client holds the backend list and picks. No proxy at all, which is
  what gRPC and service meshes generally do, and it moves the problem into every client.

Notice that none of these is "add another load balancer behind the load balancer".

---

## Coordination, and why it is different in kind

Some work cannot be done by two machines at once, no matter how you arrange them.

Allocating a unique order number. Deciding which instance runs the nightly job. Enforcing a global
rate limit. Ensuring exactly one email is sent. Every one of these needs the instances to *agree*,
and agreement is the thing that does not scale.

It does not scale because the cost goes the wrong way. More participants means more messages, more
round trips, and more time spent waiting to agree. **Coordination gets slower as you add capacity**,
which is the exact opposite of every other line in this course.

The practical approaches, in the order you should reach for them:

1. **Avoid it.** Can each instance own a partition of the work and never need to agree? This is by
   far the best answer and it is available more often than people assume.
2. **Push it into something that already solved it.** A database transaction, a unique constraint, an
   atomic increment in Redis. You are not weaker for using someone else's consensus.
3. **Use a real lock service** — etcd, ZooKeeper, Consul — when you genuinely need distributed
   agreement, and accept that it is now on your critical path.
4. **Write your own.** Almost never. A boolean in memory is not a lock; a row you `SELECT` and then
   `UPDATE` without the right isolation level is not a lock either, and Course 2 Lesson 05 explains
   precisely why.

---

## The single writer, and other things you cannot copy

Whenever exactly one of something must exist, horizontal scaling has nothing to offer:

- **A scheduled job.** Four instances with a `setInterval` run it four times. This is Lesson 03's
  quietest failure and it fails without erroring.
- **A sequence.** Anything strictly ordered has one producer by definition.
- **A licence.** Some software is licensed per core or per node, and your scaling plan is now a
  procurement conversation.
- **A stateful upstream you do not control.** A partner API with a rate limit of 100 requests per
  minute does not care that you have ten instances. Your effective limit is still 100, and now you
  need coordination to enforce it.

The last one deserves attention because it is the most common surprise. Your fleet is only as
scalable as the least scalable thing it depends on, and quite often that thing belongs to someone
else.

---

## Where the pressure went

It is worth seeing this course as a whole. Every problem was solved by moving it somewhere:

| Course | What it built | What it was quietly assuming |
|---|---|---|
| 1 · API Design | Three contracts over one catalogue | The datastore was a JavaScript array, so every read was free |
| 2 · Data & Storage | A real database, made fast | One app process in front of it |
| 3 · Scaling | A fleet of app processes | State pushed onto one shared store |

Each chapter fixed the thing the previous one was quietly assuming, and created the next one. That
is not a flaw in the sequence — **it is what architecture is.** You do not eliminate constraints, you
choose which one you would rather have, and the skill is knowing which trade you just made.

Right now the trade you have made is a shared store on the critical path of every request in a
fleet you can scale freely. Which raises the obvious question, and it is the one this series has
been walking towards since Course 1 measured a read that cost nothing:

**What if you did not do the read at all?**

That is caching, and it is Chapter IV.

---

## Before you scale anything

A checklist worth keeping, in order:

1. **Measure.** Find the throughput plateau and the resource that ran out. Lesson 01.
2. **Fix the obvious waste.** An N+1, a missing index, a synchronous call in a loop. Course 2 is full
   of things that are cheaper than a machine.
3. **Scale up.** It is a config change and it has no distributed-systems tax. Lesson 02.
4. **Scale out** — for availability and blast radius, and for throughput only if the app tier is what
   ran out. Lesson 03.
5. **Only then** consider caching, queues, replicas and sharding, in roughly that order of cost.

Most systems that "outgrew" their architecture did steps 4 and 5 without doing 1.

---

## What you should now be able to do

- [ ] Explain why a stateless fleet increases pressure on the database rather than relieving it.
- [ ] Name three ways to scale past a single load balancer, and what each requires.
- [ ] Explain why coordination gets slower as you add machines.
- [ ] Give the ordered list of approaches to coordination, and say why writing your own is last.
- [ ] Name three things that cannot be horizontally scaled at all.
- [ ] Explain why your fleet is only as scalable as its least scalable dependency.
- [ ] Give the ordered checklist and say which step most teams skip.

**Artifact for this module — the course artifact.** A **scaling plan** for one system you actually
work on, on two pages at most:

Its measured capacity today, per instance, with the resource that ran out named. Its current
topology — how many instances, behind what, sticky or shared. The three things you would do first if
traffic doubled tomorrow, in order, with the expected cost of each. And a list of what does not
scale horizontally in your system: the database, the coordination points, the single writers, the
third-party limits.

Then the part that makes it an engineering document rather than a wish: **what would change your
mind.** A metric and a threshold, not a feeling. "If p99 at the balancer exceeds 400 ms for a
sustained hour we revisit the session store" is a plan. "If it gets slow we will look at caching" is
not.

If the honest answer to "what is our measured capacity" is "we do not know", write that down as the
first finding and make measuring it the first item. It is the most common answer, and being the team
that knows its own number is a larger advantage than any of the techniques in this course.

---

Back to the [course plan](../README.md).
