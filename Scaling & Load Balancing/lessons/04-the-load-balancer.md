# 04 · The load balancer

A load balancer is a proxy that picks. A request arrives, it chooses a backend, forwards, and copies
the answer back. That is genuinely all it does, and you can read the whole of this course's version
in about two hundred lines of `labs/lb/balancer.js`.

The interesting part is not the picking. It is that on a healthy fleet of identical machines every
policy performs identically, so the choice looks like it does not matter — right up to the moment
one backend stops being like the others, which is the only moment that ever matters.

---

## L4 and L7: where it sits changes what it can know

| | Layer 4 | Layer 7 |
|---|---|---|
| Understands | TCP connections | HTTP requests |
| Decides per | Connection | Request |
| Can read | Addresses and ports | Paths, headers, cookies |
| Can do | Forward packets, fast | Retry, rewrite, route by path, terminate TLS |
| Costs | Almost nothing | A parse and a buffer per request |

An L4 balancer picks a backend when the connection opens, and every request on that connection goes
to the same place. With modern keep-alive that can mean thousands of requests pinned to one choice
made once — which is why an L4 balancer in front of long-lived HTTP connections distributes far
worse than people expect.

An L7 balancer decides per request. It can retry a failure on another backend, route `/admin`
somewhere different, and add the `X-Forwarded-For` header your logs depend on. This course is L7
throughout, because everything interesting needs to see the request.

---

## The policies

Open **Tab 4 · Balancer**. All five live in `labs/lb/policies.js` and none is more than a few lines.

**Round robin** takes each backend in turn. Perfectly even request counts, costs nothing. Even
counts are not even *load*, though, and that is its whole problem.

**Least connections** picks whichever backend has fewest requests in flight. A struggling backend
accumulates in-flight work and stops being chosen, so this routes around slowness automatically
without being told anything about it.

**Power of two choices** samples two backends at random and takes the less busy one. Nearly all the
benefit of least-connections while only inspecting two, so it stays cheap with a large pool and does
not stampede the way a global minimum does. The two samples must be drawn *independently* — deriving
the second from the first is the classic bug and quietly destroys the property that makes it work.

**Hash** sends the same key to the same backend, always. This is stickiness, and Lesson 07 is about
what it costs.

**Consistent hash** does the same, but so that losing a backend moves about 1/n of the keys instead
of nearly all of them.

---

## The measurement that makes the choice real

First run the tab with *all healthy* selected. Every policy looks the same, spreading within about
two per cent of even. If the course stopped there you would reasonably conclude the choice does not
matter.

Now run it with one instance injected as `slow` — 300 ms of added latency, which is a real
production condition: a bad disk, a noisy neighbour, a GC pause, a machine that was quietly
throttled.

```
policy          rps    to the slow instance
round-robin  164.59          26.72%
least-conn   200.98           6.36%
p2c          208.85           7.70%
```

Round robin has no idea anything is wrong. It keeps sending the sick instance its full share and the
whole service runs at 164 rps. Least connections notices within a handful of requests, drops it to
6%, and the service holds 201 rps.

**That is 22% more throughput from one line of configuration, on identical hardware, with the same
fault present.** The policy did not make anything faster. It stopped sending work to the thing that
was already struggling.

---

## The case where the clever policy is catastrophic

Now press *Run the zombie*.

A zombie is an instance that fails **instantly** — it returns a 500 in under a millisecond. It is
broken in the most complete way possible and it is also, by every measure a balancer has, the
healthiest member of the pool. It always has the fewest in-flight requests, because it never holds
one for any length of time. Its latency is superb.

With health checking suspended so the policy has to cope alone:

```
policy        into the black hole   (an even split would be 25%)
round-robin          24.53%
p2c                  48.72%
least-conn           98.41%
```

Round robin, which knows nothing, sends the zombie its fair share and no more. Least connections
sends it **almost everything**.

This is not a bug in least connections. It is the algorithm working exactly as designed on a signal
that has become a lie: *failing fast is indistinguishable from being idle.* The smarter the policy,
the more confidently it walks into the hole.

Two fixes, and you want both. Make **success rate** part of the decision, not just in-flight count.
And let the health checker eject on the outcomes of real requests, not only on probes — which is
Lesson 05. Turn health checking back on and the zombie is gone in about a second and a half.

---

## Connection reuse, and why a finite pool matters

The balancer keeps persistent connections to each backend. This is not an optimisation, it is a
correctness requirement — and it has a subtlety.

If the connection pool per backend is unbounded, there is never a queue: a new socket is always
available, "in flight" never accumulates, and **least connections has nothing to count**. It
silently degenerates into random selection. The lab caps each upstream at 64 sockets for exactly
this reason, and so does every real balancer (`keepalive 64` in nginx).

Getting keep-alive wrong has a second, uglier failure. Windows has 16,384 ephemeral ports and a
120-second `TIME_WAIT`, which caps sustained *new* connections at roughly 136 per second. Without
reuse, a load test dies of port exhaustion about two minutes in, and the symptom — connections
refused, errors climbing — looks exactly like the server failing.

---

## What the proxy costs you

An L7 balancer is not free, and the honest list is short but real:

- **A hop.** On this lab's loopback it is microseconds. Across a real network it is a millisecond or
  two each way, and Lesson 03's efficiency gap is mostly this.
- **A capacity unit of its own.** The balancer is a process with a throughput ceiling. It is now the
  thing every request passes through, and if it saturates, nothing else matters.
- **A single point of failure**, unless you run more than one — which needs DNS, anycast or a
  floating address, and is genuinely its own problem.
- **Lost client information**, unless you propagate it. Your backends now see the balancer's address
  as the client, which is what `X-Forwarded-For` exists to repair, and why anything doing
  rate-limiting by IP behind a proxy needs to be told where to look.

---

## Retries, which hide problems beautifully

When a backend returns a 5xx, an L7 balancer can quietly try another one. In the Failure tab this is
the difference between a dead instance being invisible and it costing a measurable share of
requests.

It is close to magic, and it has two edges. Every retry is work done twice, so a fleet already near
capacity can retry itself into a far worse outage than the one it was covering. And it is only safe
when the request is idempotent — retrying a `GET` is free, retrying a payment is a different
afternoon entirely. nginx spells this out as `proxy_next_upstream`, and the lab's equivalent is one
branch in `proxy()`.

---

## What you should now be able to do

- [ ] Say what an L4 balancer cannot do, and why keep-alive makes it distribute poorly.
- [ ] Describe round robin, least connections and power of two choices, and what each costs.
- [ ] Explain why every policy looks identical on a healthy fleet.
- [ ] Explain the zombie: why the best policy sends it the most traffic.
- [ ] Say why an unbounded upstream pool makes least connections meaningless.
- [ ] Name what adding a proxy costs, including the two things that are not latency.
- [ ] State when a retry is safe and when it makes an outage worse.

**Artifact for this module:** a **measured policy comparison**. Take any service with more than one
backend — this lab if you have no other — and record throughput and p99 under two policies with one
backend degraded. Write down the percentage of traffic each policy sent to the sick backend. Then
answer in writing: which policy is your production balancer using right now, do you know that or are
you assuming it, and what would happen to it if one of your backends became a zombie?

Next: [05 · Health checks](05-health-checks.md)
