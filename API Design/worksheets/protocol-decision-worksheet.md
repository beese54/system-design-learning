# Protocol decision worksheet

Fill this in per API boundary — not per system. One system usually needs different answers at
different boundaries, and that is correct, not indecisive.

**Boundary being decided:** _from ______________ to _______________

---

## 1. Consumer

- Who calls it? ☐ browser ☐ mobile app ☐ partner org ☐ our own service ☐ third-party stranger
- Can we make them upgrade? ☐ yes, same deploy ☐ yes, with notice ☐ no, never
- What tooling can we assume they have? ______

## 2. Network between us

- ☐ same datacentre / LAN  ☐ internet, good  ☐ mobile / high latency / lossy
- Round-trip time we should design against: ______ ms
- Is bandwidth or battery a real constraint? ______

## 3. Access shape

- Reads vs writes: ______ % reads
- Is the data cacheable? For how long? ______
- Do different consumers need very different slices of the same data? ☐ yes ☐ no
- Do results arrive over time (progress, feeds, live updates)? ☐ yes ☐ no

## 4. Scale

- Expected calls/second, now and in a year: ______ / ______
- Typical payload size: ______
- Does serialisation cost show up in profiles today? ☐ yes ☐ no ☐ unmeasured

## 5. Team reality

- Have we run this style in production before? ☐ yes ☐ no
- Can we debug it at 3 a.m. with the tools we have? ______
- Who operates the extra machinery it needs (gateway, codegen, cost limits)? ______

---

## Score it

Give each style 0–3 per row for **this** boundary. Then argue with the total; do not obey it.

| Question | REST | GraphQL | gRPC |
|---|---|---|---|
| Consumers can use it with zero new tooling | | | |
| HTTP caching would meaningfully help here | | | |
| Clients need different slices of one graph | | | |
| Payload size / parse cost matters at our volume | | | |
| Streaming is a real requirement | | | |
| Compiler-enforced types would prevent our real bugs | | | |
| We can operate its extra machinery | | | |
| We can debug it with the tools we already use | | | |
| **Total** | | | |

## Decision

**Chosen:** ______

**Because** (three sentences maximum, aimed at someone reading this in a year):

**Rejected alternatives and the specific reason:**

**Costs we are knowingly accepting:**

**Evidence that would make us revisit:** (a metric and a threshold, not a feeling)

**Decided by / date:** ______
