# Lesson 9 — Choosing a style, and living with it afterwards

**Lab:** tab **6 · Compare** — run the benchmark before you read the table below.
**Worksheet:** [`worksheets/protocol-decision-worksheet.md`](../worksheets/protocol-decision-worksheet.md)
**Time:** 30 minutes reading, 60 minutes producing your decision record.

---

## The measurement first

"Render one artist page: the artist, their albums, every track." Same data, same machine:

| Style | Round trips | Bytes | What the number hides |
|---|---|---|---|
| REST (naive) | 4 | 2,568 | on 4G that is ~400 ms of pure latency |
| REST (`?expand=tracks`) | 4 | 3,106 | bigger payloads, fewer cacheable pieces |
| GraphQL | 1 | 795 | one round trip; server-side reads unchanged unless you batch |
| gRPC | 1 | 199 | protobuf; the browser cannot call it without a gateway |

Run it yourself before trusting these. Then remember what localhost hides: **round trips are
nearly free here and expensive everywhere else**. A benchmark that ignores your consumer's
network is a benchmark about your laptop.

## The decision, honestly

```
Does a browser or a stranger call it directly?
├── yes
│    └── Do different clients need very different slices of one graph?
│         ├── yes → GraphQL at the edge (and budget for caching + cost limits)
│         └── no  → REST + HTTP caching
└── no — service to service
     └── High volume, strict types, or streaming?
          ├── yes → gRPC
          └── no  → REST is fine. Boring is a feature.
```

Most real systems answer **all three**: gRPC between services, REST or GraphQL at the edge,
events for anything that must not block. "Which one" is usually the wrong question; "which one
*here*" is the right one.

## The factors that actually decide it

| Factor | Pushes you to |
|---|---|
| Consumers you do not control | REST |
| Many client shapes, one graph | GraphQL |
| Same-team services, high call volume | gRPC |
| Read-heavy, cacheable | REST |
| Streaming or bidirectional | gRPC (or SSE/WebSocket beside REST) |
| Strict typing enforced by a compiler | gRPC |
| Team has never run it before | whatever you can operate at 3 a.m. |
| Debuggability with a terminal | REST |
| Payload size at scale | gRPC |
| Front end iterating faster than the backend | GraphQL |

That second-to-last row is not a joke. Operability beats elegance: an API style your team can
debug, monitor and explain to a new hire will outperform a better-suited one they cannot.

## Costs people forget to count

- **GraphQL**: normalised client caches, persisted queries, depth and cost limits, per-field
  tracing, schema governance across teams. You are adopting a platform, not a library.
- **gRPC**: codegen in CI, a proto registry or shared repo, gateway for browsers, `grpcurl` in
  everyone's toolkit, version discipline across languages.
- **REST**: the discipline to stay consistent across dozens of endpoints and years, plus
  bespoke solutions when a screen really does need a graph.

## Living with the choice: evolution

Once someone integrates, your contract is a liability you maintain. The rules are the same in
all three styles:

**Always safe (additive):** new endpoint / type / RPC; new optional field; new enum value *if*
clients were told to tolerate unknowns; relaxed validation.

**Always breaking:** removing or renaming; changing a type; making an optional field required;
tightening validation; changing a default; changing the meaning of an existing field.

| | REST | GraphQL | gRPC |
|---|---|---|---|
| Add a field | safe | safe (nobody selects it unasked) | safe (new tag) |
| Remove a field | breaking → `/v2` | `@deprecated` + measure field usage, then remove | `reserved` the tag, never reuse |
| Version | `/v1`, `/v2` side by side | one evolving schema; versioning is a smell | `package …v1` → `…v2` |
| Deprecation signal | `Deprecation` / `Sunset` headers, changelog | `@deprecated(reason:)` in the schema | comment + registry policy |

GraphQL's field-level usage stats make it the one style where you can *prove* nobody uses a
field before deleting it. Use that; it is the strongest argument for the schema-first world.

## The deprecation playbook

1. **Announce** with a date, in the changelog and in the response (`Deprecation`, `Sunset`,
   or `@deprecated`).
2. **Measure** usage per consumer. If you cannot, you cannot deprecate — instrument first.
3. **Contact** the top consumers directly. A dashboard is not a conversation.
4. **Brown-out**: fail the endpoint for short windows near the date so quiet clients notice
   while it is still recoverable.
5. **Remove**, and keep a clear error explaining what replaced it.

## Common failure modes, named

- **The database viewer** — endpoints mirroring tables; every schema change breaks a client.
- **The chatty mobile app** — REST N+1 over a cell network; 2 s screen loads that look fine on
  the office wifi.
- **The GraphQL DB melt** — one legal query, no depth or cost limits, one bad afternoon.
- **The distributed monolith** — gRPC everywhere, every service deploying in lockstep; you have
  bought network latency and kept all the coupling.
- **The v1 that never dies** — no usage metrics, so no deprecation is ever safe.
- **The unversioned public API** — silently breaking changes, and integrators who never trust
  you again.

## What you should now be able to do

- [ ] Choose a style for a concrete case and defend it with your own measurements.
- [ ] List what each style costs to *operate*, not just to write.
- [ ] Classify any proposed change as additive or breaking without hesitating.
- [ ] Run a deprecation that does not surprise anyone.

**Artifact for this module (and the course):** a one-page decision record for a real project —
context, the jobs, the styles considered, the measured numbers, the choice, the operational
costs you are accepting, and what evidence would make you change your mind. That document is
the deliverable a staff engineer would ask for, and producing it is the proof you learned this.

Back to the [course plan](../README.md).
