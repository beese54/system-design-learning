# Lesson 6 — REST in depth

**Lab:** tab **3 · REST**. **Source:** `labs/rest/api.js` (~230 lines, no framework).
**Time:** 40 minutes reading, 60 minutes in the lab and the code.

---

## The idea

REST models a system as **resources with addresses**, manipulated with a small fixed set of
verbs. Its bet: HTTP already knows how to fetch, cache, retry, authorise and version
addressable things, so reuse that instead of inventing your own.

Roy Fielding's constraints, in the form that matters day to day:

| Constraint | What it means for you |
|---|---|
| Client–server | separate concerns; each evolves alone |
| **Stateless** | each request carries everything needed; any server can answer |
| Cacheable | responses say whether and how long they may be reused |
| Uniform interface | same verbs, same status codes, everywhere |
| Layered system | proxies, CDNs and gateways can sit in the middle unmodified |
| Code on demand (optional) | rarely used |

Most "REST APIs" are really HTTP JSON APIs, and that is fine. The valuable part is the uniform
interface plus statelessness plus caching — not hypermedia purity.

## Resource modelling

```
/artists                      collection
/artists/{id}                 one resource
/artists/{id}/albums          sub-collection (relationship)
/albums/{id}                  the album is also addressable on its own
/albums/{id}/tracks           sub-collection
/tracks/{id}
```

Rules that hold up:

- **Nouns, plural, lowercase.** `/artists`, never `/getArtist` or `/Artist`.
- **Nest one level, then link.** `/artists/a1/albums` is fine; `/artists/a1/albums/b1/tracks/t1`
  is a maintenance trap — `/tracks/t1` is enough.
- **Actions that are not CRUD** get modelled as resources where possible
  (`POST /albums/b1/publications`) or as a clearly-named sub-resource
  (`POST /orders/o1/cancellation`). A verb endpoint is a last resort, not a first instinct.
- **Query strings modify a collection view**, they do not identify resources: `?limit`,
  `?cursor`, `?country=IE`, `?fields=id,name`, `?sort=-year`.

## Methods and status codes, as used in the lab

| Call | Status | Notes |
|---|---|---|
| `GET /v1/artists?limit=2` | `200` + `ETag` | paginated collection |
| `GET /v1/artists/a1` | `200` | one resource |
| `GET` again with `If-None-Match` | **`304`**, empty body | the cheapest response you can send |
| `GET /v1/artists/nope` | `404` + `application/problem+json` | absent, permanently |
| `POST /v1/artists` (valid) | **`201`** + `Location:` | tells the client where the new thing lives |
| `POST /v1/artists` (invalid) | `422` + field-level errors | well-formed, but wrong |
| `POST` again with the same `Idempotency-Key` | `200` + `Idempotent-Replay: true` | no duplicate created |
| `PATCH /v1/artists/a2` | `200` | partial update |
| `DELETE /v1/artists/a2` | `204`, no body | nothing left to say |
| Wrong method on a collection | `405` + `Allow: GET, POST` | tells you what *is* allowed |

Press each of these in the lab and read the *Response headers* panel. The status line and the
headers carry as much of the contract as the body does.

`PUT` vs `PATCH`: `PUT` replaces the whole representation (idempotent, and it deletes fields
you omit); `PATCH` applies a partial change. Most APIs want `PATCH` and accidentally document
`PUT`.

## Caching — REST's biggest structural advantage

```js
// labs/rest/api.js
function maybe304(req, res, body, extraHeaders = {}) {
  const etag = etagOf(body);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });    // no body at all
    res.end();
    return 0;
  }
  return send(res, 200, body, { ETag: etag, 'Cache-Control': 'public, max-age=60' });
}
```

Eleven lines gives you: browser caching, CDN caching, conditional revalidation, and a `304`
that costs zero payload bytes. This works **because a URL identifies one stable thing** — the
property GraphQL and gRPC give up.

Cache-control vocabulary worth knowing: `public` vs `private`, `max-age`, `no-store` (never
persist — use for anything sensitive), `must-revalidate`, and `Vary` (which request headers
change the response; get this wrong and users see each other's data).

## Pagination

The lab uses opaque cursors:

```jsonc
{
  "data": [ /* … */ ],
  "page": { "limit": 2, "next": "/rest/v1/artists?limit=2&cursor=YTI" }
}
```

- Opaque so clients cannot compute it, which keeps your implementation free.
- The `next` link is *ready to use* — the client concatenates nothing.
- `limit` is capped server-side (50 here) no matter what is requested.
- Offset pagination (`?page=3`) is fine for small, stable datasets and terrible for large or
  changing ones: rows shift under the reader and deep offsets scan the whole table.

## Over-fetching, under-fetching and the N+1 waterfall

Small resources cache beautifully and cost round trips. Rendering one artist page in the lab:

```
GET /artists/a1            →  1 trip
GET /artists/a1/albums     →  1 trip
GET /albums/b1/tracks      ┐
GET /albums/b2/tracks      ┘  N trips, one per album
```

Four trips here; twenty for a busy artist. Mitigations, in the order you should reach for them:

1. **Sparse fieldsets** — `?fields=id,name` to send less. (Fixes over-fetching, not trips.)
2. **Compound documents** — `?expand=tracks` to send more per trip. Fewer trips, bigger and
   less cacheable payloads. Use narrowly; an `?expand` that takes ten values is a query
   language wearing a REST costume.
3. **Purpose-built endpoints** — `/artist-pages/a1` for one important screen. Pragmatic and
   honest; the risk is one endpoint per screen forever.
4. **A different style** — this is precisely where GraphQL earns its keep (Lesson 7).

Run tab 6's benchmark and look at *round trips* and *bytes* together. `?expand` cut nothing
here because the page still needed the album list first — a **dependent** call chain that no
amount of multiplexing removes.

## Versioning

- **URL versioning** (`/v1/…`) — ugly, obvious, and by far the easiest to operate. Used here.
- **Header versioning** (`Accept: application/vnd.riff.v2+json`) — purer, harder to debug,
  easy for a client to get wrong invisibly.
- **No versioning, additive only** — works when you control all clients.

Whatever you pick: additive changes never bump the version, breaking changes always do, both
versions run side by side, and deprecation comes with a date and per-consumer usage metrics.

## When REST is the right answer

- Public APIs, partner APIs, anything a stranger must integrate with using tools they have.
- Resource-shaped domains: documents, entities, CRUD with real business rules.
- Read-heavy workloads where HTTP caching does the heavy lifting.
- Any team that needs `curl` and a browser to be sufficient debugging tools.

## When it hurts

- Deeply nested, client-specific view data (the N+1 waterfall).
- Many client types wanting very different slices of the same graph.
- Ultra-high-volume internal RPC where JSON parsing shows up in profiles.
- Streaming or bidirectional communication — possible with SSE/WebSocket, never native.

## What you should now be able to do

- [ ] Model a domain as resources and defend where you stopped nesting.
- [ ] Choose the right status code without looking it up, including `201`, `204`, `304`, `422`, `429`.
- [ ] Implement conditional GET and explain what it saves.
- [ ] Explain cursor vs offset pagination to a colleague who wants `?page=`.
- [ ] Diagnose an N+1 waterfall and name three fixes before reaching for GraphQL.

**Exercises:** [`exercises/exercises.md`](../exercises/exercises.md) §REST — add a `playlists`
resource with pagination, ETags, `201 + Location`, and idempotent creation.

Next: [Lesson 7 — GraphQL in depth](07-graphql.md)
