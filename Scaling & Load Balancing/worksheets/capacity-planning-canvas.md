# Capacity Planning Canvas

Fill this in for one service, before you change its instance count. If you cannot fill in section 1
you are not capacity planning, you are guessing with a budget — which is the state most teams are
in, and admitting it is the first useful step.

---

## 1. What you have measured

**Service:** ______________________  **Measured on:** ______________  **By:** ____________

| Measurement | Value | How you got it |
|---|---|---|
| Throughput plateau, one instance | | |
| Concurrency at which it plateaus | | |
| p50 / p95 / p99 at that point | | |
| p99 at twice that concurrency | | |
| The resource that ran out | | |

> The last row is the one people skip and the only one that decides anything. Cores, a connection
> pool, a downstream API, a lock, memory bandwidth — until you can name it, you do not know whether
> another instance will help. Lesson 03's control experiment exists because "adding instances helped"
> and "instance count was the cause" are different claims.

**If any of these are blank, write down what stopped you:** ______________________________

---

## 2. The load you are planning for

| | Today | Peak today | Expected in 12 months |
|---|---|---|---|
| Requests per second | | | |
| Concurrent users | | | |
| When peaks happen | | | |

> Peaks are usually predictable — the sale opens, the batch runs, everyone logs in at 09:00. A
> predictable peak wants scheduled scaling, not a reactive autoscaler that finds out afterwards.

**Is the peak predictable?** ☐ yes, at ______________  ☐ no, it is genuinely random

---

## 3. The arithmetic

```
instances = (peak arrival rate ÷ throughput plateau) ÷ utilisation target
```

| | Value | Why |
|---|---|---|
| Peak arrival rate | | |
| Plateau per instance | | from section 1 |
| Utilisation target | | |
| **Instances needed** | | |
| Minimum floor | | what absorbs a spike while new capacity boots |
| Time from decision to full share | | boot + start + warm-up; this is what autoscaling cannot beat |

> A utilisation target above about 70% buys a bill reduction and pays for it in tail latency, because
> waiting scales with 1 ÷ (1 − utilisation). Headroom is not waste; it is what makes latency stable.

---

## 4. What you scale on

**Signal:** ☐ CPU  ☐ request rate  ☐ p99 latency  ☐ queue depth  ☐ in-flight requests  ☐ other ______

**Threshold:** ______________  **Cooldown out:** __________  **Cooldown in:** __________

> If you ticked CPU, answer this: is the service CPU-bound? An I/O-bound service can be completely
> saturated at 15% CPU, and an autoscaler watching CPU will do nothing at all while users time out.

**Why this signal and not CPU:** _______________________________________________

---

## 5. The cost of being wrong

| | One instance too few | One instance too many |
|---|---|---|
| What happens | | |
| Who notices, how fast | | |
| Cost | | |
| How long to recover | | |

> If these two columns look comparable, check them again. They almost never are, and a policy that
> scales in as eagerly as it scales out has assumed they are.

---

## 6. What does not scale here

List everything that adding instances will not help, and what you would do instead.

| Constraint | Why more instances do not help | What would |
|---|---|---|
| | | |
| | | |
| | | |

> Prompts: the database, the session store, a scheduled job, a global rate limit, a third-party API
> quota, a per-core licence, anything that must happen exactly once.

---

## 7. What would change your mind

| Decision made here | Evidence that would make us revisit |
|---|---|
| | |
| | |

> A metric and a threshold, not a feeling. "If p99 exceeds 400 ms for a sustained hour" is a trigger.
> "If it gets slow" is a hope.

---

**Owner:** ______  **Date:** ______  **Next review:** ______
