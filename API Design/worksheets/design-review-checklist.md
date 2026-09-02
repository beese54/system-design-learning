# API design review checklist

Run this over a contract **before** it is implemented, and again before it ships. Anything
unticked is either fixed or written down as a known, accepted gap.

---

## Contract shape

- [ ] Names come from the business vocabulary, not the framework or the schema
- [ ] Naming, casing and pluralisation are consistent across every operation
- [ ] Dates are ISO 8601 with a timezone; money is minor units + currency code
- [ ] IDs are opaque strings, not sequential integers
- [ ] The response shape reflects consumer jobs, not table structure
- [ ] Nothing in the payload exists "just in case"
- [ ] A newcomer could guess the next operation's name correctly

## Correctness and semantics

- [ ] Safe operations are actually safe (no writes behind a `GET` or a `Query`)
- [ ] Every unsafe operation is idempotent, or its non-idempotence is documented and justified
- [ ] Retries cannot double-charge, double-send or double-create
- [ ] Partial failure behaviour is defined — what does the client see, what should they do?
- [ ] Concurrency is handled: optimistic locking (`If-Match`/ETag, version field) where two
      writers are possible

## Errors

- [ ] One error shape across every operation
- [ ] Correct status/code per failure class (400 / 401 / 403 / 404 / 409 / 422 / 429 / 5xx)
- [ ] Errors say which field and what to do, not just "invalid request"
- [ ] Client can tell "retry later" from "never retry"
- [ ] No stack traces, SQL, internal hostnames or credentials in any error

## Collections and cost

- [ ] Every collection is paginated, with a server-side cap on page size
- [ ] Cursors are opaque; offsets only where the dataset is small and stable
- [ ] Sorting and filtering are explicit, documented and index-backed
- [ ] Rate limits exist, are documented, and return `429` with `Retry-After`
- [ ] Query depth / cost limits exist (GraphQL) or payload size limits (all)
- [ ] A single call cannot fan out unboundedly on the server (N+1 checked and batched)

## Security

- [ ] Authentication is required by default; public operations are the explicit exception
- [ ] Authorisation is checked **per object**, not just per route (change an id — does it leak?)
- [ ] No client-supplied field can escalate privilege, set a price, or pick a user id
- [ ] Input is validated against the schema; unknown fields are rejected or ignored deliberately
- [ ] Nothing sensitive appears in URLs, logs or cache keys
- [ ] `Cache-Control: no-store` on anything personal; `Vary` is correct where responses differ
- [ ] Sensitive fields are not returned "for convenience"

## Performance and caching

- [ ] Cacheable responses carry `ETag` / `Cache-Control` (REST) or have a documented cache plan
- [ ] The common screen or job needs a defensible number of round trips
- [ ] Payload sizes measured, not assumed
- [ ] Timeouts and deadlines are set on every outbound call this API makes

## Evolution

- [ ] Versioning scheme decided and applied
- [ ] Every planned change classified as additive or breaking
- [ ] Deprecation policy exists with a notice period and dates
- [ ] Usage is measured per consumer (you cannot deprecate what you cannot measure)
- [ ] Removed identifiers can never be reused (`reserved` tags in protobuf; retired URLs 410)

## Documentation and operations

- [ ] Machine-readable spec exists and generates the reference docs
- [ ] Quickstart works when pasted, with real example requests and responses
- [ ] Error catalogue and limits are documented
- [ ] Metrics per operation: latency percentiles, error rate, usage by consumer
- [ ] Alerts exist for error rate and latency (and, for GraphQL, for error *bodies* — not just status)
- [ ] Changelog is public to the consumers who need it

---

**Reviewer:** ______  **Date:** ______
**Accepted gaps (with reason and owner):**
