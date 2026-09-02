# API Design Canvas

Copy this file per API you design. Fill it in **before** writing handlers. If a box is hard to
fill, that is the design problem surfacing early — which is the entire point.

---

## 0. One-line purpose

> This API lets ______________ do ______________ so that ______________.

## 1. Consumers and their jobs (Lesson 5, step 1)

| Consumer | Job, in their words | Constraints (network, release cadence, tooling) | Priority |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

Audience: ☐ public ☐ partner ☐ internal — *(this decides your versioning strictness)*

## 2. Domain model (step 2)

Entities, identity and relationships:

| Entity | ID format | Key fields | Relationships |
|---|---|---|---|
| | | | |
| | | | |

- What is a **resource** (own lifecycle / permissions / URL) vs a **field**?
- What vocabulary does the business already use? (use exactly those words)

## 3. Style decision (step 3)

Chosen style: ☐ REST ☐ GraphQL ☐ gRPC ☐ events/webhooks ☐ combination

**Because:**

**What would change my mind:**

*(Long form: [`protocol-decision-worksheet.md`](protocol-decision-worksheet.md))*

## 4. The contract (step 4)

### Operations

| Operation | Signature (URL+method / field / RPC) | Auth | Idempotent? | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |

### Conventions — decide once, apply everywhere

- Casing: ______  Dates: ISO 8601 UTC  Money: ______  IDs: ______
- Pagination: ☐ cursor ☐ offset · default limit ____ · max limit ____
- Filtering / sorting syntax: ______
- Collection envelope shape: ______

### Error shape

```jsonc
{
  "type": "",
  "title": "",
  "status": 0,
  "detail": "",
  "errors": [{ "field": "", "issue": "" }]
}
```

Status/​code map: 400 ____ · 401 ____ · 403 ____ · 404 ____ · 409 ____ · 422 ____ · 429 ____

### Limits

- Rate limit: ______ per ______ per ______, response on breach: `429` + `Retry-After`
- Max payload: ______ · Max page size: ______ · Max query depth/cost: ______
- Timeout / deadline: ______

## 5. Prototype plan (step 5)

- Mock served by: ______
- First consumer to build against it: ______
- Contract edits their prototype forced:

## 6. Review (step 6)

Run [`design-review-checklist.md`](design-review-checklist.md). Unresolved items:

## 7. Operations (step 7)

- Spec file lives at: ______ (OpenAPI / SDL / `.proto`)
- Docs + quickstart: ______
- Metrics per operation and per consumer: ______
- Changelog: ______
- Versioning policy: ______ · Deprecation window: ______

## 8. Change policy

- Additive changes we may make without notice:
- Changes that require a new version:
- How consumers find out:
