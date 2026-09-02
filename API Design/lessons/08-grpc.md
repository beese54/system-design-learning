# Lesson 8 — gRPC in depth

**Lab:** tab **5 · gRPC**. **Source:** `labs/grpc/catalog.proto`, `server.js`, `bridge.js`.
**Time:** 40 minutes reading, 60 minutes in the lab.

---

## The idea

Not resources, not a query language — **typed function calls across the network**. You define
services and messages in a `.proto` file, a compiler generates client and server code in every
language you use, and calls travel as binary protobuf over HTTP/2.

```
        catalog.proto                       ← the single source of truth
              │  protoc / proto-loader
      ┌───────┴────────┐
      ▼                ▼
 server stubs     client stubs      ← generated; a field mismatch is a build error
 (implement)      (just call it)
```

```proto
service CatalogService {
  rpc GetArtist  (GetArtistRequest)  returns (Artist);
  rpc ListAlbums (ListAlbumsRequest) returns (AlbumList);
  rpc WatchPlays (WatchPlaysRequest) returns (stream PlayEvent);
}
```

The client writes `client.GetArtist({id: "a1"})` and gets a typed `Artist` back. No URL, no
status code, no JSON parsing — the network is (almost) invisible, which is both the appeal and
the trap.

## Protobuf: field numbers are the contract

```proto
message Artist {
  string id      = 1;
  string name    = 2;
  string country = 3;
}
```

On the wire, protobuf writes **tag numbers**, not names. Consequences you must internalise:

- **Renaming a field is free** — the wire format never knew the name.
- **Reusing a retired tag number silently corrupts data** — an old client's `country` lands in
  your new `formed`. Mark retired tags `reserved 3;`.
- **Adding a field is safe** — unknown fields are ignored by old readers and, in proto3,
  preserved on round trips.
- **Changing a type is not safe.** `int32` → `string` on the same tag is a data corruption bug
  that no test with matching client and server will ever catch.
- **Everything is optional in proto3**, with typed zero values (`""`, `0`, `false`). "Absent"
  and "empty" look identical unless you use `optional` or a wrapper — decide deliberately.

The payoff is measurable. In the lab, `ListAlbums` with tracks is **199 protobuf bytes vs 523
bytes of the equivalent JSON — 62 % smaller** — plus a parse that is a memory copy rather than
a string scan.

## The four call types

| Type | Signature | Use |
|---|---|---|
| **Unary** | `rpc Get (Req) returns (Res)` | the 95 % case |
| **Server streaming** | `returns (stream Res)` | live feeds, large result sets, progress |
| **Client streaming** | `(stream Req) returns (Res)` | uploads, batched telemetry |
| **Bidirectional** | `(stream Req) returns (stream Res)` | chat, sync, multiplexed sessions |

All four ride one HTTP/2 connection with no bolt-on protocol. Press **WatchPlays** in the lab:
one request, ten responses arriving over several seconds, one connection. Expressing that in
REST means SSE, WebSocket or polling — all of which you would have to design yourself.

## Status codes, deadlines, and the things REST gave you for free

gRPC has its **own** status vocabulary — `OK`, `INVALID_ARGUMENT`, `NOT_FOUND`,
`PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `UNAVAILABLE`,
`DEADLINE_EXCEEDED` — and they are **not** HTTP status codes. When you put a gateway in front,
mapping between the two vocabularies is real design work: `NOT_FOUND (5)` → `404`,
`INVALID_ARGUMENT (3)` → `400`, `FAILED_PRECONDITION (9)` → `409` or `422`, and so on. Do it in
one place, deliberately, or every service will invent its own mapping.

Three habits gRPC makes easy and you should adopt everywhere:

```js
const deadline = new Date(Date.now() + 2000);         // labs/grpc/bridge.js
client.GetArtist({ id }, { deadline }, callback);
```

- **Deadlines on every call** — propagated across hops, so a slow leaf cancels the whole chain
  instead of piling up work nobody is waiting for.
- **Cancellation** — the client hanging up actually stops the server (the lab's stream clears
  its interval on `cancelled`).
- **Metadata** — key/value pairs alongside the message, for auth tokens and tracing headers.

Retries need care: unary calls are only safely retryable if the method is idempotent, exactly as
in REST. The protocol is different; the distributed-systems physics is not.

## Why your browser cannot call it

Browsers give JavaScript no control over HTTP/2 frames or trailers, so a page cannot speak gRPC.
Options:

- **gRPC-Web** + a proxy (Envoy, or a framework equivalent) that translates.
- **A gateway** exposing REST/JSON or GraphQL to the outside and gRPC inside — the common shape.
- **Connect / gRPC-compatible protocols** that work over HTTP/1.1 as well.

The lab uses a hand-rolled version of exactly this: `labs/grpc/bridge.js` is a gRPC *client*
that re-emits results as JSON and SSE for the page. That extra hop is the honest cost of gRPC
at the edge, and it is the main reason the standard architecture is **gRPC internally,
REST or GraphQL publicly**.

## Designing good gRPC services

- **Name RPCs as verbs on resources**: `GetArtist`, `ListAlbums`, `CreatePlaylist`,
  `BatchUpdateTracks`. Follow Google's AIP conventions unless you have a reason not to.
- **Wrap every request and response in its own message type** — `GetArtistRequest`, not
  `string`. Adding a field later then never changes the signature.
- **Version in the package**: `package riff.catalog.v1;` → a v2 can live beside it.
- **Paginate** with `page_size` / `page_token`; the network being fast does not make unbounded
  lists safe.
- **Reserve** removed tags and names: `reserved 4; reserved "old_name";`
- **Errors carry detail**: use `google.rpc.Status` details rather than stuffing prose into the
  message string.
- **Do not leak internal types** into a service other teams depend on. A `.proto` is a public
  contract exactly like a URL is.

## When gRPC is the right answer

- Service-to-service inside your own perimeter, where both sides deploy on your schedule.
- High call volume where serialisation cost and payload size show up in profiles.
- Polyglot systems: one `.proto`, real clients in Go, Java, Python, Node, Rust.
- Streaming as a first-class need.
- Teams that want the contract enforced by a compiler, not a code review.

## When it hurts

- Browser-facing APIs (needs a proxy) and public APIs (needs your consumers to adopt tooling).
- Human debugging: you cannot `curl` it and read the answer; you need `grpcurl` and the proto.
- Caching: no HTTP caching, no CDN. You build any caching you want.
- Build complexity: codegen in CI, proto registry, version discipline across repos.
- Small systems where the strictness costs more than it saves.

## What you should now be able to do

- [ ] Write a `.proto` with messages, a service, and a streaming RPC.
- [ ] Explain why field numbers matter more than field names, and what `reserved` prevents.
- [ ] Choose between the four call types for a given problem.
- [ ] Explain deadlines and cancellation, and why they belong in every RPC system.
- [ ] Say precisely why a browser needs a gateway, and where you would put it.

**Exercises:** [`exercises/exercises.md`](../exercises/exercises.md) §gRPC — add `Playlist`
messages, a `CreatePlaylist` RPC with `INVALID_ARGUMENT` handling, and a streaming RPC; then
measure the protobuf-vs-JSON size difference for your new message.

Next: [Lesson 9 — Choosing and evolving](09-choosing-and-evolving.md)
