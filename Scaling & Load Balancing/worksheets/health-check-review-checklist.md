# Health Check Review Checklist

Run this over any service that sits behind a load balancer or an orchestrator. It is deliberately
short — a checklist you actually use beats a comprehensive one you skim.

Anything unticked is either fixed or written down at the bottom as a known, accepted gap.

**Service:** ______________________  **Reviewed:** ______________

---

## 1. The three questions are three endpoints

- [ ] Liveness and readiness are **separate endpoints**, not one `/health` used for both.
- [ ] Liveness checks nothing but this process. No database, no cache, no downstream service.
- [ ] Readiness reports only on **local** state: still starting, draining, local resources exhausted.
- [ ] If startup is slow, there is a startup probe with a deadline longer than the liveness timeout.
- [ ] Someone can say, without looking it up, what happens when each one fails.

> Liveness failure means "kill this process". If liveness touches the database, a database blip
> restarts every instance you own, repeatedly, while all of them were fine.

---

## 2. The check can actually fail

- [ ] There is a fault that makes readiness return non-200. You have named it: ______________
- [ ] The check exercises something that would be **false if the service could not do its job**.
- [ ] It is not merely "the process is up" or "the config parsed".
- [ ] It is cheap and constant-time — no unbounded query, no fan-out to other services.

> The question that catches most designs: could this endpoint return 200 while a real request
> fails? If yes, name the fault. Course 2 shipped a check that passed while the database was still
> loading, and this course measured a fault that answers every probe perfectly and fails all work.

---

## 3. Nothing shared is in the loop

- [ ] Readiness does **not** depend on the database, the cache, a queue or another service.
- [ ] If it does, you have written down what happens when that dependency has a bad minute:

  > _______________________________________________________________

- [ ] Deep dependency checks exist, and they feed **monitoring** rather than the load balancer.

> This is the cascade. Every instance fails its check at the same instant, the balancer removes the
> whole fleet, and requests that did not need the dependency get nothing. Measured in the lab: 2 of 4
> healthy on a deep check, 4 of 4 on a local readiness check, with the dependency broken in both.

---

## 4. Timing is deliberate

| Parameter | Yours | Notes |
|---|---|---|
| Probe interval | | |
| Probe timeout | | must be shorter than the interval |
| Failures before ejection | | |
| Successes before return | | should be different from the line above |
| Detection floor (interval × failures) | | |

- [ ] The detection floor is a number you chose, not one you inherited.
- [ ] Failures-to-eject and successes-to-return are **asymmetric**: quick to remove, slow to trust.
- [ ] The probe timeout is short enough to catch a hang, long enough not to eject a slow-but-working
      backend.

> A hung backend — accepts the connection, never answers — is only ever detected by the probe
> timeout. A TCP-level check sees an open port and calls it healthy forever.

---

## 5. Both kinds of checking are in use

- [ ] Active probes run against every backend on a schedule.
- [ ] Real request failures also count toward ejection (passive).
- [ ] You can say which of the two would catch a backend that 500s every request.

> Active probing finds a backend that stopped answering, including at 3am with no traffic. Passive
> observation finds one that answers wrongly, which no probe will ever catch.

---

## 6. Recovery is designed, not incidental

- [ ] A returning backend receives traffic **gradually**, not all at once.
- [ ] You know the ramp duration: ______________
- [ ] A flapping backend cannot oscillate in and out — hysteresis is configured.
- [ ] Draining stops traffic **before** it stops accepting: mark not-ready, wait at least one check
      interval, then close.

> Without a ramp, a cold instance takes a full share, fails again, and you have built an oscillator.
> Without the wait during a drain, the balancer sends requests to a listener that has already closed
> — an outage you scheduled.

---

## 7. The blast radius has a limit

- [ ] There is a panic threshold: the balancer refuses to eject beyond some fraction of the fleet.
- [ ] You know what it is: ______%  ☐ or: there is none, and that is accepted
- [ ] Someone has reasoned about what happens if every backend fails its check at once.

> When more than half the pool fails simultaneously, the cause is almost always shared — a
> dependency, a config push, or the check itself. Sending traffic to possibly-working backends beats
> sending it nowhere.

---

## 8. It has been tested by breaking something

- [ ] A backend has actually been broken and the ejection observed, with timings.
- [ ] More than one **kind** of break was tried: refused, hung, erroring, slow.
- [ ] The error budget during detection was measured, not estimated.

> An argument that ejection works is a hypothesis. A transcript with timings is evidence.

---

**Accepted gaps (with reason and owner):**

| Gap | Why it is accepted | Owner | Revisit when |
|---|---|---|---|
| | | | |

**Verdict:** ☐ ship  ☐ ship with the fixes above  ☐ redesign the checks
