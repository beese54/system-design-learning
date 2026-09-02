# Lesson 7 — GraphQL in depth

**Lab:** tab **4 · GraphQL**. **Source:** `labs/graphql/schema.js`, `labs/graphql/api.js`.
**Time:** 40 minutes reading, 60 minutes in the lab.

---

## The idea

One endpoint, one strongly-typed **graph** of your domain, and the **client** declares the
shape of the response. Where REST's server decides what a resource looks like, GraphQL's
server publishes what is *available* and each query picks a subtree.

```graphql
{                              →   {
  artist(id: "a1") {                 "data": {
    name                               "artist": {
    albums {                             "name": "Nova Kim",
      title                              "albums": [
      tracks { title }                     { "title": "Static Garden",
    }                                        "tracks": [ { "title": "Tin Roof" } ] }
  }                                        ]
}                                        }
                                       }
                                     }
```

The response mirrors the query exactly. That is the whole pitch: no over-fetching, no
under-fetching, no waterfall — one round trip for a screen's worth of data.

## The schema is the contract

```graphql
type Artist {
  id: ID!
  name: String!
  albums(sort: AlbumSort = YEAR_DESC): [Album!]!
}

type Album {
  id: ID!
  title: String!
  artist: Artist!
  tracks: [Track!]!
  runtimeSeconds: Int!      # derived on the server, so every client agrees
}

type Query    { artist(id: ID!): Artist, artists(country: String): [Artist!]! }
type Mutation { addArtist(input: NewArtist!): Artist! }
```

- `!` means non-null; `[Album!]!` is a non-null list of non-null albums.
- **Introspection**: clients can ask the server for the schema at runtime — which is why
  GraphQL tooling (autocomplete, explorers, codegen) is so good out of the box. Press
  *View schema (SDL)* in the lab.
- There is **no second document to keep in sync**. The schema is the docs, the validation and
  the type source for generated clients.

## Resolvers and where the cost hides

Each field is resolved by a function, and a field is only resolved if it was asked for. That
laziness is what kills over-fetching — and it is also where the danger lives:

```js
class ArtistModel {
  albums({ sort }) { return this.ctx.albumsOf(this.a.id).map(b => new AlbumModel(b, this.ctx)); }
}
class AlbumModel {
  tracks() { return this.ctx.tracksOf(this.b.id).map(t => new TrackModel(t, this.ctx)); }
}
```

Ask for 50 artists with their albums and tracks and you have just issued 1 + 50 + N database
queries. **GraphQL removes the round trips between client and server; it does not remove the
N+1 inside your server.** It moves the problem where your users cannot see it.

The standard fix is batching + per-request caching (DataLoader). The lab has the idea in eight
lines:

```js
export function makeContext({ batch = false } = {}) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!batch) return fn();
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return { albumsOf: id => memo('albums:' + id, () => albumsOfArtist(id)),
           tracksOf: id => memo('tracks:' + id, () => tracksOfAlbum(id)) };
}
```

**Do this in the lab:** run *two resources, one round trip* with batching off, note the
*datastore reads* metric, then tick **per-request batching** and run it again. Same response,
fewer reads. That gap is the difference between a GraphQL API that scales and one that melts
the database on a Tuesday.

## Queries, mutations, subscriptions

- **Query** — reads. Fields execute in parallel.
- **Mutation** — writes. Top-level fields execute **in series**, so a mutation with three
  fields is three sequential operations. That serial guarantee is the only real difference.
- **Subscription** — a long-lived stream, usually over WebSocket. Powerful, and a separate
  operational commitment (connection state, scaling, auth on reconnect).

Also worth knowing: **variables** (`query($id: ID!)`) so queries are static and cacheable,
**aliases** (ask for the same field twice with different arguments — try the *arguments +
aliases* preset), and **fragments** (reusable selection sets that mirror UI components).

## What you give up

### 1. HTTP caching
Every request is `POST /graphql`. No URLs, no `ETag`, no CDN, no `304`. You replace it with:
- **persisted queries** — clients send a hash; the server maps it to a known query, which can
  then be `GET`-able and CDN-cacheable
- **client-side normalised caches** (Apollo, Relay, urql) keyed by type + id
- **`@cacheControl`-style hints** aggregated per response

That is real machinery to build and operate, replacing something REST got from the protocol.

### 2. Status codes
GraphQL answers `200` almost always. Failures arrive as an `errors` array, often *alongside*
partial `data` — a genuine feature (one broken field does not fail the screen) with a real
cost: dashboards, alerts and retry middleware that watch status codes see nothing wrong. Run
the *a field that does not exist* preset and look at the HTTP status in the metrics row.

### 3. Predictable cost
A client can write a legal query that is catastrophically expensive. The mitigations are not
optional in production:

- **depth limiting** — the lab rejects anything deeper than 8; run the *malicious deep query*
  preset and watch it get refused
- **cost/complexity analysis** — assign weights per field, reject over a budget
- **persisted-query allow-lists** — in a first-party app, only queries you shipped may run
- **timeouts and pagination** on every list field
- **disable introspection in production** for non-public APIs

### 4. Observability
"One endpoint, one status code" defeats per-endpoint metrics. You need per-**operation** and
per-**field** instrumentation (`operationName`, resolver tracing) before you go live, not after
your first incident.

## When GraphQL is the right answer

- Many client types (web, iOS, Android, TV) needing different slices of one graph.
- Deeply nested, view-shaped data where REST would waterfall.
- Fast-moving front ends: adding a field is a client-side change, not a backend release.
- A **BFF / aggregation layer** stitching several internal services into one client-facing graph.

## When it hurts

- Simple CRUD with one client — you have bought a lot of machinery for nothing.
- Cache-heavy public reads, where HTTP caching alone would have carried you.
- File uploads/downloads and binary data (possible, awkward).
- Untrusted public clients, unless you commit to allow-lists and cost limits.
- Small teams without capacity to run the caching, cost-limiting and tracing that GraphQL
  assumes you will build.

## What you should now be able to do

- [ ] Write a schema with types, arguments, enums, input types and nullability that means something.
- [ ] Explain why GraphQL kills round trips but not N+1, and show the fix.
- [ ] Say what replaces HTTP caching and status codes, and what that costs.
- [ ] Name four defences against a hostile or careless query.

**Exercises:** [`exercises/exercises.md`](../exercises/exercises.md) §GraphQL — add `Playlist`
to the schema, with a mutation, an argument, and a query that would N+1 without batching.

Next: [Lesson 8 — gRPC in depth](08-grpc.md)
