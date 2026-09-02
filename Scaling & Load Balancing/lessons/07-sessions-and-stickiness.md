# 07 · Sessions and stickiness

Lesson 03 listed what has to leave a process before instances become interchangeable, and put
sessions at the top. This lesson prices the three ways of dealing with them, because "just use a
shared session store" is advice with a cost that almost nobody quotes.

Open **Tab 5 · Stateless**. Three buttons, three measurements, and the argument between them is the
whole of it.

---

## One: leave it in memory and hope

A user logs in. The instance that served them keeps their session in a `Map`. Their next request
arrives, the balancer picks a backend by round robin, and it lands wherever it lands.

```
instances                4
follow-ups on the wrong instance   75.35%
theoretical (n-1)/n                75%
```

Three quarters of follow-up requests reach a process that has never heard of that user. Every one of
those is a logout, an empty basket, a form that lost its contents.

The formula is `(n − 1) / n`, and it has a property worth sitting with: **the more instances you add,
the worse it gets.** Two instances lose half your sessions. Ten lose ninety per cent. In-process
state does not merely fail to scale — it punishes scaling, and it punishes it harder the more
seriously you attempt it.

This is why it is nearly always found in the worst possible way. It works perfectly on one machine,
passes every test, and breaks the day you finally add the second instance you have been planning
for months.

---

## Two: stickiness, which fixes it and costs you two things

Make the balancer send the same user to the same backend every time. The wrong-instance rate goes to
zero and the in-memory session works again.

The balancer needs a key: a cookie it sets, a header, or the client's IP address. IP is the tempting
one and the worst — an office, a mobile carrier or a corporate VPN puts thousands of distinct people
behind one address, and they all land on one backend.

### Cost one: affinity is not balance

Press *Sticky routing*. Keys hash unevenly, so the busiest instance carries more than the quietest:

```
load skew between busiest and quietest   2.16%
```

With 20,000 evenly-shaped keys that is small. It is small because this lab's users are identical. In
production they are not: one customer has ten users and another has ten thousand, and the hash does
not know or care. **No load-aware policy can fix this** — least connections cannot help when the key
must go where the key must go. You have traded away the balancer's ability to balance.

### Cost two: the pool changes, and everyone moves

This is the one that actually matters. Lose an instance — a deploy, a crash, a scale-down — and the
keys have to be redistributed. How many move depends entirely on your hashing:

```
lose 1 instance of 4
  modulo hash  (hash % n)     74.4% of users move
  consistent ring             26.1% of users move
  theoretical ideal (1/n)     25%
```

With `hash % n`, changing `n` changes the answer for almost every key. Removing one backend of four
relocates three quarters of your users, and every one of them is logged out — over a fault that
affected a quarter of your capacity.

A consistent hash ring places each instance at many points around a circle and sends a key to the
first instance clockwise of it. Remove an instance and only the keys sitting in its arcs move: about
`1/n` of them. The other three quarters cannot tell anything happened.

**That difference is the entire reason consistent hashing exists.** Not better balance — it is
slightly worse at balance, which is why it needs virtual nodes. Just far less disruption when the
pool changes. It is the same idea underneath sharded caches and distributed hash tables, and this is
the clearest place to see why it was invented.

You can read the ring in `labs/lb/policies.js`; it is about twenty lines.

### The costs nobody lists

Stickiness also quietly takes away things you wanted:

- **You cannot drain cleanly.** Removing an instance for a deploy means dropping its users' sessions,
  every time you deploy.
- **A hot key stays hot.** One heavy tenant pinned to one backend cannot be spread, ever.
- **Autoscaling fights it.** Every scale event reshuffles keys, so the thing you added to handle load
  causes a burst of logouts.

---

## Three: move it out, and pay for it per request

Put the session in the shared database and every instance can serve every user. Press *Shared in
Postgres*:

```
session read + write   p50  1.98 ms
                       p99  8.49 ms
wrong-instance rate    0%
load skew              none - any policy works again
```

Two milliseconds, on every request, forever. That is the statelessness tax and it is worth being
precise about it: it is not a one-off migration cost, it is a permanent per-request cost that scales
with your traffic.

It is also, almost always, the right trade. What you buy is that your instances become genuinely
interchangeable, and interchangeable is what makes everything else in this course possible — you can
deploy without dropping sessions, lose a machine without anyone noticing, autoscale freely, and use
whichever balancing policy is actually best.

In production this store is usually Redis rather than Postgres, for the obvious reason that a
session read is a key lookup and a cache is built for key lookups. The shape of the argument does
not change; only the constant does.

---

## The thing this moves rather than solves

Notice what just happened. The session left the process — and landed on a shared dependency that is
now on the critical path of every request in the entire fleet.

Your instances are stateless and disposable. Your session store is neither. It is a single thing
every request touches, and its failure is now everybody's failure. You have not eliminated the
stateful component; you have concentrated it and made it more important.

That is not an argument against doing it. It is the honest description of what you did, and it is
Lesson 09's subject.

---

## Choosing, in one paragraph

Shared store unless you have a specific reason not to. Stickiness is a legitimate optimisation for
things that are genuinely expensive to move — a large in-memory working set, a WebSocket connection,
a long-running upload — but it should be a deliberate exception with the reshuffle cost written
down, not the default because it was easier. And if you do use it, use a consistent ring: the code
is twenty lines and the difference is 74% of your users against 26%.

---

## What you should now be able to do

- [ ] Derive the wrong-instance rate for in-memory sessions, and say why it worsens with scale.
- [ ] Explain why IP-based stickiness is the worst key choice.
- [ ] Explain why stickiness makes a load-aware balancing policy useless.
- [ ] State how many keys move under modulo hashing versus a consistent ring, and why.
- [ ] Name three things stickiness takes away besides balance.
- [ ] Quote the per-request cost of a shared session store and say what it buys.
- [ ] Explain what moving state out of the process does not solve.

**Artifact for this module:** a **session decision record** for one real service. Name where session
state lives today, what the wrong-instance rate would be if you removed stickiness tomorrow, and
what one deploy currently costs your users in dropped sessions. Then choose: sticky or shared, with
the measured cost of the option you rejected written next to it, and a line saying what evidence
would make you revisit — a metric and a threshold, not a feeling. If you are sticky by accident
rather than by decision, that is the finding, and it is extremely common.

Next: [08 · Autoscaling, and what to scale on](08-autoscaling.md)
