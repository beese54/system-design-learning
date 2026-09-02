# Lesson 5 — The API design process

**Lab:** tab **7 · Design process** — the seven steps with a checklist that saves your progress.
**Worksheet:** [`worksheets/api-design-canvas.md`](../worksheets/api-design-canvas.md)
**Time:** 30 minutes reading, 90 minutes doing it for real on a system you care about.

---

Design happens **before** the first route handler. The order below is not bureaucracy; each
step is cheap where it sits and brutally expensive one step later.

```
1 jobs ──▶ 2 domain ──▶ 3 style ──▶ 4 contract ──▶ 5 prototype ──▶ 6 review ──▶ 7 ship
                                       ▲                 │
                                       └── rewrite here ─┘   ← the cheapest edit you will make
```

---

## Step 1 · Find the jobs, not the tables

Write down what each consumer is trying to accomplish, in their words, as sentences:

- "Show an artist page with their albums and track lengths."
- "Let a partner sync yesterday's plays every morning."
- "Let the mobile app work when the tube goes into a tunnel."

For each, note the actor, the trigger, the data they need, and their constraints (slow network?
no proxy? cannot ship an update for six weeks?).

**Output:** 5–10 job sentences with the actor named.
**Smell:** your first draft mirrors your database. You have designed a database viewer.

## Step 2 · Model the domain

Name the nouns, their relationships, and their identity. This vocabulary outlives every
implementation detail you will ever write.

- Use the words the business already says out loud. `artist`, not `content_entity`.
- Decide identity: opaque IDs (`a1`, `trk_9f2…`), not database row numbers — those leak volume,
  invite enumeration and pin you to one storage engine.
- Mark cardinality: an artist has many albums; an album has one artist.
- Decide what is a resource and what is a field. If it has its own lifecycle, its own
  permissions, or its own URL in a UI, it is probably a resource.

**Output:** an entity sketch with IDs, relationships and cardinality.

## Step 3 · Choose the style deliberately

REST, GraphQL, gRPC, events — pick with the decision flow (lab tab 6, or
[`worksheets/protocol-decision-worksheet.md`](../worksheets/protocol-decision-worksheet.md))
and **write down the reason**. "It is what the team knows" is a legitimate reason. An
unrecorded one is not, because in a year nobody will remember the constraint that drove it.

**Output:** one defensible paragraph, plus a note on what would change your mind.

## Step 4 · Design the contract — before the implementation

Write the spec file first: OpenAPI, GraphQL SDL, or `.proto`. Writing it forces every decision
into the open while it is still free to change.

Decide once, apply everywhere:

- resource or type names, casing, plurals
- every payload shape, **including errors**
- pagination, filtering, sorting conventions
- auth: who calls this, with what credential, at what rate
- what is required vs optional, and every default
- idempotency for unsafe operations

**Output:** a spec file that exists before any handler. In this course, `labs/grpc/catalog.proto`
and the SDL in `labs/graphql/schema.js` are exactly this artifact.

## Step 5 · Prototype against the contract

Generate a mock from the spec and have a real consumer build a real screen against it. You
will discover the missing field on day one — when it costs a text edit — instead of after
launch, when it costs a version.

- Prism or `msw` for OpenAPI; any GraphQL server can serve a schema with mocked resolvers.
- Give the mock to the person who will actually integrate. Watch them, do not brief them.
- Every question they ask is a documentation gap or a naming failure. Write both down.

**Output:** a working client screen fed by a mock, and a list of contract edits.

## Step 6 · Review it like a publication

Use [`worksheets/design-review-checklist.md`](../worksheets/design-review-checklist.md). The
questions that catch the most:

- What happens on a **retry**? On a **partial failure**? On a **client three versions old**?
- Can a caller reach another tenant's object by changing an id?
- Is every collection paginated and every limit capped?
- Is there exactly one error shape, and does it say what to do next?
- Is every unsafe operation idempotent, or is it documented why not?
- Is the versioning and deprecation policy written down, with dates?

**Output:** a signed-off contract plus a written change policy.

## Step 7 · Ship with the operational parts attached

An API without docs, limits and metrics is a liability that happens to return JSON.

- Reference docs generated from the spec, plus a quickstart that works when pasted.
- Rate limits and quotas: documented, enforced, and returning `429` with `Retry-After`.
- Metrics per endpoint: latency percentiles, error rate, usage **per consumer** — you cannot
  deprecate what you cannot measure.
- A changelog, and a way to warn consumers before you break them.

**Output:** docs with runnable examples, dashboards, limits, changelog.

---

## How this looks compressed for a small internal API

You do not need a two-week process for an endpoint two teams use. The compressed version, in
about an hour:

1. Three job sentences in the ticket.
2. The nouns, in a comment.
3. "gRPC, because it is internal and high-volume" — one line in the PR description.
4. The `.proto` in the first commit, reviewed on its own before any implementation.
5. The consuming team reviews the `.proto`, not the code.
6. Checklist run over the diff.
7. Docstrings in the proto + a dashboard panel.

Same seven steps. The point is the *order*, not the ceremony.

## What you should now be able to do

- [ ] Run the seven steps on a real feature without looking them up.
- [ ] Explain why the spec is written before the handler.
- [ ] Say what each step produces and what it costs to skip.
- [ ] Compress the process honestly for a small internal API.

**Artifact for this module:** a completed
[API Design Canvas](../worksheets/api-design-canvas.md) for a system you care about — jobs,
entities, chosen style with rationale, draft contract, error shape, limits, change policy.
This is the single most reusable thing you will make in this course.

Next: [Lesson 6 — REST in depth](06-rest.md)
