# Lesson 2 — APIs in system architecture

**Lab:** tab **2 · Architecture** — click every box in the diagram.
**Time:** 25 minutes reading, 35 minutes mapping your own system.

---

## APIs are where a system's seams are

Architecture is mostly the question *where do we cut?* An API is a cut you have committed to.
Draw any system and the arrows crossing box boundaries are its APIs — and the boxes are only
independent to the degree those arrows are well-designed.

```
   Web app        Mobile app        Partner systems
      │                │                   │
      └────────────────┼───────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │   API gateway / edge             │  auth · rate limits · TLS
        │                                  │  routing · versioning · logs
        └──────────────────────────────────┘
             │              │            │
       ┌─────▼────┐  ┌──────▼─────┐  ┌───▼──────┐
       │ Catalog  │  │ Playback   │  │ Billing  │
       │ REST     │◀▶│ gRPC       │◀▶│ gRPC     │
       └─────┬────┘  └──────┬─────┘  └───┬──────┘
             ▼              ▼            ▼
         Postgres      event stream    Stripe API
                                    (someone else's contract)
```

Three things worth staring at:

1. **The protocol changes at the edge.** Public traffic arrives as REST or GraphQL over
   HTTPS; internal hops are gRPC or events. That is not fashion — it is each side optimising
   for a different consumer (Lesson 9).
2. **Cross-cutting concerns live in one place.** Auth, quotas, TLS, request logging, version
   routing. Spread them across services and you will get eight subtly different implementations
   and one incident.
3. **The bottom-right box.** Stripe's API is *someone else's* contract, and you are the client
   with hard-coded assumptions. Every rule in this course will one day be applied to you by a
   stranger reading your docs at 2 a.m.

## Three audiences, three rule sets

| | **Public** | **Partner** | **Internal** |
|---|---|---|---|
| Consumer | strangers | named organisations | your own teams |
| Discovery | docs, SDKs, search | onboarding, sandbox | the repo |
| Cost of a breaking change | permanent; you cannot call them | contractual, sometimes legal | one coordinated deploy |
| Versioning | strict, long deprecations | negotiated with dates | often none needed |
| Typical protocol | REST (+ webhooks) | REST + webhooks | gRPC or events |
| Optimise for | clarity and stability | predictability | latency and type safety |

The single most common architecture mistake is applying internal rules to a public API
("we'll just change it, everyone deploys together") or public rules to an internal one
(three versions of a service ten people use, all maintained forever).

## The API is where coupling becomes visible

Coupling never disappears; it moves. An API decides *which kind* you get:

- **Shape coupling** — the client depends on your response fields. Fix: expose what consumers
  need, not your table columns; add fields, never repurpose them.
- **Temporal coupling** — the caller blocks while you work. Fix: make long jobs asynchronous —
  accept with `202`, hand back a status resource, or publish an event.
- **Availability coupling** — your outage becomes their outage. Fix: timeouts, retries with
  backoff and jitter, circuit breakers, and a degraded answer where one is honest.
- **Deployment coupling** — both sides must ship together. Acceptable internally, fatal
  publicly. This is what versioning buys you.

A useful review question: *if this dependency's owners disappeared for a month, what happens
to us?* The answer is a property of the API, not of their team.

## Synchronous request/response is not the only shape

This course focuses on request/response (REST, GraphQL, gRPC) because that is where design
skill transfers. But part of designing an API is noticing when it should not be a call at all:

| Shape | Use when | Example here |
|---|---|---|
| Request/response | the caller needs the answer to continue | `GET /artists/a1` |
| Server streaming | results arrive over time | gRPC `WatchPlays` in Lab 3 |
| Webhooks | *you* must tell *them*, later | "payment settled" |
| Events / queue | many consumers, none blocking | "track played" → analytics, royalties, recommendations |

Rule of thumb: **if the caller does not need the result to continue, do not make them wait
for it.** Half of all latency problems are a synchronous call that had no business being one.

## Conway's law, briefly

Teams ship their communication structure as architecture. If two teams own one service, its
API will grow two dialects. If one team owns three services, their "APIs" will quietly become
function calls with network latency attached. When you choose service boundaries, you are
choosing team boundaries — and vice versa. Design the seam where the org can actually hold it.

## What you should now be able to do

- [ ] Sketch a system as boxes and arrows and name every arrow as an API.
- [ ] Say which of your APIs are public, partner or internal — and apply different rules to each.
- [ ] Name the four kinds of coupling and one mitigation for each.
- [ ] Spot a synchronous call that should be an event.

**Artifact for this module:** map a system you actually work on (or the last one you used).
Boxes for consumers, edge, services, stores. Label each arrow with its protocol, its audience,
and a 1–5 score for *cost of changing it*. The 5s are where the rest of this course pays off.

Next: [Lesson 3 — Principles of good API design](03-design-principles.md)
