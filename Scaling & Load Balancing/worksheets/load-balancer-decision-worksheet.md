# Load Balancer Decision Worksheet

One sheet per boundary where traffic is distributed — not per system. A system usually distributes
traffic in several places with different answers, and that is correct rather than inconsistent.

**Boundary being decided:** from _______________ to _______________

---

## 1. What sits behind it

| | Answer |
|---|---|
| How many backends | |
| Are they identical in capability | ☐ yes ☐ no — how they differ: |
| Are they identical in **hardware** | ☐ yes ☐ no |
| Do requests vary in cost | ☐ barely ☐ somewhat ☐ enormously |
| Is the work CPU-bound or wait-bound | |

> The last two rows decide almost everything below. On a homogeneous fleet serving uniform requests,
> every policy performs identically and the choice does not matter. The moment either is untrue,
> round robin starts costing you throughput.

---

## 2. Layer

☐ **L4** — picks per connection. Cheap, fast, blind to the request.
☐ **L7** — picks per request. Can retry, route by path, rewrite headers.

**If L4, with keep-alive:** how many requests will ride a single connection? __________

> An L4 balancer chooses once per connection. With modern keep-alive that can pin thousands of
> requests to one decision, which distributes far worse than the word "balancer" implies.

### The balancer itself

| Question | Answer |
|---|---|
| Its own throughput ceiling | |
| Is it a single point of failure | ☐ yes ☐ no — how it fails over: |
| Do backends see real client addresses | ☐ yes ☐ via X-Forwarded-For ☐ no |
| Anything rate-limiting by IP behind it | ☐ no ☐ yes — does it read the header? |

---

## 3. Policy

Score each 0–3 for **this** boundary. Then argue with the total; do not obey it.

| Question | Round robin | Least conn | P2C | Hash |
|---|---|---|---|---|
| Backends are identical and requests uniform | | | | |
| One slow backend must not sink the service | | | | |
| A backend that fails fast must not attract traffic | | | | |
| Pool is large and the policy must stay cheap | | | | |
| The same key must reach the same backend | | | | |
| **Total** | | | | |

**Chosen policy:** ☐ round robin ☐ least connections ☐ power of two ☐ hash ☐ consistent hash

**Why, in one sentence:** _______________________________________________

> Row three is the zombie, and it is the one that inverts the ranking. An instance failing instantly
> has the fewest in-flight requests, so least connections sends it the most traffic — measured at
> 98.41% against a fair share of 25%. If you chose a load-aware policy, section 5 must not be blank.

---

## 4. If you chose stickiness

**Key:** ☐ cookie we set  ☐ header  ☐ client IP  ☐ other ______________

> Client IP is the tempting one and the worst. An office, a VPN or a mobile carrier puts thousands of
> distinct people behind one address, and they all land on one backend.

| Question | Answer |
|---|---|
| Measured load skew between busiest and quietest | |
| Keys that move when one backend leaves | ______% |
| Using a consistent ring | ☐ yes ☐ no — if no, why not |
| What a deploy currently costs users | |

> Modulo hashing moves nearly every key when the pool changes: measured at 74.4% against a consistent
> ring's 26.1%. If you are sticky and not using a ring, that number is what each deploy costs.

**Why stickiness rather than a shared store:** _______________________________

---

## 5. Health checking

| | Answer |
|---|---|
| Endpoint probed | |
| Does it touch anything shared | ☐ no ☐ yes — what: |
| Probe interval / timeout | ______ / ______ |
| Failures before ejection | |
| Successes before return | |
| Detection floor (interval × failures) | |
| Slow start on return | ☐ yes, ______ ☐ no |
| Panic threshold | ☐ yes, ______% ☐ no ☐ do not know |
| Passive ejection on real failures | ☐ yes ☐ no |

> If "touches anything shared" is yes, write down here what happens to every backend when that shared
> thing has a bad minute: _______________________________________________
>
> If passive ejection is no, you cannot detect a backend that answers probes and fails work. That
> fault was never detected by probing in the lab, at any interval.

---

## 6. Retries

☐ On  ☐ Off  ☐ Do not know

| | Answer |
|---|---|
| Which conditions retry | |
| How many attempts | |
| Are all retried requests idempotent | ☐ yes ☐ no ☐ not sure |
| What happens if the fleet is near capacity | |

> Retry is the single most effective thing on this sheet and it does work twice. A fleet already near
> its plateau can retry itself into a worse outage than the one it was hiding.

---

## 7. Argue the other side

Write two sentences arguing *against* the policy you chose. If you cannot, you have not understood
the trade.

>

---

**Decided by / date:** ______________  **Revisit when:** ______________
