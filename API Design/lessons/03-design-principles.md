# Lesson 3 — The principles that make an API good

**Lab:** tab **3 · REST**. Click through *Endpoints*, then *Try the mechanics*, and finish
with the red **the BAD design** button. Compare them side by side.
**Time:** 35 minutes reading, 25 minutes in the lab.

---

These ten hold across REST, GraphQL and gRPC. Protocol choice changes *how* you honour them,
never *whether* you should.

## 1. Design for the consumer's job, not your schema

The first draft of most APIs is a database viewer: one endpoint per table, every column
exposed. It ships fast and hurts forever, because your tables change for reasons your
consumers cannot see, and their screens need joins you did not anticipate.

Start from sentences: *"show an artist page"*, *"let a partner sync yesterday's plays"*.
Then design the smallest contract that serves them.

> **Test:** can you rename a database column without a client noticing? If not, you published
> your schema, not an API.

## 2. Consistency beats cleverness

Every inconsistency is a thing to remember, and memory is the scarce resource in an
integration. Pick one answer for each of these and never deviate:

- casing (`snake_case` or `camelCase` — pick one, apply everywhere)
- dates and times (ISO 8601, UTC, always; `2026-08-31T12:43:58Z`)
- money (minor units as integers + currency code; never floats)
- IDs (opaque strings; not auto-increment integers that leak volume and invite enumeration)
- collection envelopes, pagination parameters, sort syntax, error shape

An API where a developer can *guess* the next endpoint correctly is the goal. In the lab,
`/artists/a1/albums` and `/albums/b1/tracks` follow one rule; you could have guessed the second
after seeing the first.

## 3. Names are the interface

You will rewrite the implementation three times and the vocabulary never. Use the words the
business already uses. Avoid `data`, `info`, `item`, `object`, `process`, `handle`, and any
name that describes your framework rather than the domain. If two names compete, ask which one
a new hire would say out loud.

## 4. Make the common case easy and the whole surface small

Every endpoint, field and option is a lifetime commitment: documented, tested, secured,
migrated. Ship the smallest surface that does the job; add on evidence, not speculation.
It is trivial to add a field later and near-impossible to remove one.

## 5. Errors are a feature, and they need one shape

Errors are the part of your API that integrators handle most and you test least. Give them:

- **the right status** — `400` malformed, `401` unauthenticated, `403` unauthorised, `404`
  absent, `409` conflict, `422` well-formed but invalid, `429` rate-limited, `5xx` our fault
- **one body shape everywhere** — the lab uses RFC 9457 `application/problem+json`
- **actionable detail** — which field, what was wrong, what to do
- **a retry signal** — is this permanent, or should the client back off and try again?
- **no leaks** — no stack traces, SQL, or internal hostnames

```jsonc
// GET /rest/v1/artists  (POST with a bad body)  → 422
{
  "type": "https://riff.example/errors/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "One or more fields were rejected.",
  "errors": [
    { "field": "name",    "issue": "required" },
    { "field": "country", "issue": "must be an ISO 3166-1 alpha-2 code" }
  ]
}
```

Compare with the red button in the lab, which returns **`200 OK`** carrying
`{"status":"error"}`. Every proxy, retry layer, dashboard and alert in the world now believes
that request succeeded. That is the bug — not the wording.

## 6. Safety, idempotency and retries

The network will deliver your request twice. Design for it:

| Property | Meaning | Methods |
|---|---|---|
| **Safe** | changes nothing | `GET`, `HEAD`, `OPTIONS` |
| **Idempotent** | doing it twice ≡ doing it once | `GET`, `PUT`, `DELETE`, `PATCH` (if written that way) |
| Neither | each call is a new effect | `POST` |

For unsafe operations that must survive a retry, accept an **idempotency key** and return the
first result on a repeat. Try the *idempotent retry* button twice in the lab: the second call
returns `200` with `Idempotent-Replay: true` instead of creating a duplicate artist. Payments
APIs live or die on this.

## 7. Pagination, filtering and limits — from day one

Any collection that can grow must be paginated at launch. Retrofitting pagination is a
breaking change, and unbounded lists are how a Tuesday becomes an incident.

- Prefer **cursor** pagination over `offset`/`limit`: stable under inserts, cheap on large tables.
- Make the cursor **opaque** (the lab base64s the last id) so clients cannot do arithmetic on it
  and you stay free to change the scheme.
- Cap `limit` server-side. The lab caps at 50 regardless of what you ask for.
- Same for cost: rate limits, payload size limits, query depth limits (Lesson 7).

## 8. Evolve additively; version only when you must

Non-breaking, always allowed: adding an endpoint, adding an optional field, adding an enum
value *if clients were told to tolerate unknowns*, relaxing a validation rule.

Breaking: removing or renaming anything, changing a type, making an optional field required,
tightening validation, changing defaults, changing the meaning of an existing field.

When you must break: a new version (`/v2`), both live at once, a deprecation date in writing,
`Deprecation`/`Sunset` headers, and usage metrics per consumer so you know who is still on v1.
"We'll email everyone" is not a migration plan.

## 9. Secure at the resource, not at the route

Authentication answers *who is this*; authorisation answers *may they touch this object*.
The classic breach is a correct login plus an unchecked `id` — change `a1` to `a2` and read
someone else's data. Check ownership on every object you return or mutate. Also:

- validate input against the schema at the boundary, and reject unknown fields loudly
- never accept a client-supplied `role`, `price` or `userId` for a privileged decision
- rate-limit per credential, and return `429` with `Retry-After`
- log who did what, and never log the credential itself

## 10. Documentation and examples are part of the product

Undocumented behaviour gets discovered, depended on and then locked in anyway — but wrongly.
Ship a machine-readable spec (OpenAPI, SDL, `.proto`), a quickstart that works when pasted,
runnable examples per endpoint, error catalogue, limits, and a changelog. Generate the
reference from the spec so it cannot drift.

---

## Grading the lab's own API

| Principle | `/rest/v1/...` (good) | `/rest/bad/getArtistData?id=a1` |
|---|---|---|
| Consumer-shaped | resources map to screens | dumps every field, always |
| Naming | nouns + HTTP verbs | verb in the URL, `data`, `info` |
| Errors | `404` + problem+json | `200 OK` with an error string |
| Caching | `ETag` + `Cache-Control` → `304` | none; every call is full price |
| Least surface | `?fields=` when you want less | you get everything, forever |

Run both and watch the **bytes** and **datastore reads** counters. The bad endpoint is not
merely ugly; it is measurably more expensive on every single call.

## What you should now be able to do

- [ ] Recite the ten principles and give one concrete violation you have personally met.
- [ ] Write an error response that a client can act on without reading your source.
- [ ] Explain idempotency to someone who thinks retries are free.
- [ ] Say which changes to a contract are safe and which need a version.

**Artifact for this module:** take the API you wrote up in Lesson 1 and grade it 0–2 against
each principle. For every score below 2, write the fix and what it buys. That document is a
design review — and it is the exact skill this course is for.

Next: [Lesson 4 — How protocols shape API design](04-protocols-shape-design.md)
