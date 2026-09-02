# Lesson 4 — How application protocols shape API design

**Lab:** tabs **3 · REST**, **4 · GraphQL**, **5 · gRPC**. Watch the *Response headers* panel
and the byte counters. Then tab **6 · Compare** and run the benchmark.
**Time:** 30 minutes reading, 30 minutes measuring.

---

## The claim

Your protocol is not a delivery detail you pick after designing the API. It decides **which
design ideas are cheap, which are expensive, and which are impossible**. Every style in this
course is really "an API design idea, plus the protocol that makes it affordable".

## Layers, quickly

```
your API design        resources / a type graph / procedures
─────────────────────────────────────────────────────────────
application protocol   HTTP/1.1 · HTTP/2 · HTTP/3 · WebSocket
─────────────────────────────────────────────────────────────
transport              TCP (or QUIC over UDP for HTTP/3)
```

REST leans hard on the application protocol. GraphQL mostly ignores it. gRPC depends on a
specific version of it. That single sentence explains most of their differences.

## What HTTP gives you for free — if your design lets it

| HTTP feature | The design decision that unlocks it | You lose it when… |
|---|---|---|
| **Methods** (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`) | put the verb in the method, the noun in the URL | everything is `POST /graphql` |
| **Status codes** | let the status line carry the outcome | you return `200` with an error body |
| **Caching** (`ETag`, `Cache-Control`, `304`) | give each thing a stable URL | one URL serves every possible response |
| **Conditional requests** (`If-None-Match`) | identify representations | responses are query-shaped, not resource-shaped |
| **Content negotiation** (`Accept`) | separate resource from representation | the format is baked into the path |
| **Range requests** | expose large blobs as resources | you stream through a custom endpoint |
| **Auth, proxies, CDNs, browsers, curl** | speak plain HTTP | you invent a framing on top |

Seen live in the lab: click *collection, paginated*, tick **send If-None-Match**, click again.
The second response is **`304 Not Modified`, zero body bytes**. That is the whole of your
caching layer for one line of server code — and it exists only because the URL identifies one
stable thing.

## HTTP/1.1 vs HTTP/2 — the constraint that created two design styles

**HTTP/1.1** sends one request at a time per connection. Browsers open ~6 connections per host;
after that, requests queue. So on HTTP/1.1 **round trips are the scarce resource**, and API
design pays for chattiness. That pressure produced compound documents, `?expand=`, and
eventually GraphQL.

**HTTP/2** multiplexes many streams over one connection, compresses headers (HPACK), and
supports long-lived bidirectional streams. Round trips get much cheaper — though not free:
latency is still latency, and a dependent chain of calls (fetch A to learn B's id) still
serialises. gRPC *requires* HTTP/2, which is exactly why it can offer four streaming modes
with no bolt-ons.

**HTTP/3** moves to QUIC over UDP: no TCP head-of-line blocking, faster handshakes. Mostly
free performance for the same API design.

Numbers from a real run of the lab's benchmark ("render one artist page"):

| Style | Round trips | Bytes |
|---|---|---|
| REST (naive) | 4 | 2,568 |
| REST (`?expand=tracks`) | 4 | 3,106 |
| GraphQL | 1 | 795 |
| gRPC | 1 | 199 (protobuf; 523 as JSON) |

Read that table twice, because the obvious conclusion is wrong. On localhost a round trip
costs ~1 ms and the byte counts hardly matter. On a mobile network each round trip is
80–150 ms and those four REST calls are half a second before the server does any work. The
same table on a LAN between two services says something different again — there, the 199 bytes
and the absence of JSON parsing matter more than the trip count.

**The protocol does not tell you what is fast. Your network and your consumer do.**

## Serialisation: JSON vs protobuf

| | JSON | Protobuf |
|---|---|---|
| Readable by a human | yes | no, you need the `.proto` |
| Self-describing | yes (field names on the wire) | no (field *numbers* on the wire) |
| Size | baseline | typically 30–70 % smaller |
| Parse cost | high (string scanning) | low (binary, generated code) |
| Schema | optional, often drifts | mandatory, compiled |
| Evolution | ad hoc | rules built in (reserved tags, optional fields) |

The lab shows the same `ListAlbums` payload as **199 protobuf bytes vs 523 JSON bytes** — 62 %
smaller. At ten requests a second nobody cares. At a hundred thousand, that is a hardware line
item and a p99 improvement.

Note the trade you make with a binary format: you can no longer debug with `curl` and your
eyes, and no browser can read it without a gateway. Legibility is a real feature; it is just
not always the most valuable one.

## Streaming, and what each protocol makes possible

| Need | HTTP/1.1 | HTTP/2 | gRPC (on HTTP/2) |
|---|---|---|---|
| Server pushes updates | polling, long-polling, SSE | SSE | server streaming, native |
| Client uploads a stream | chunked upload | chunked | client streaming, native |
| Both directions | WebSocket (separate protocol) | WebSocket | bidirectional streaming, native |

Lab 3's `WatchPlays` is one request answered by many messages on one connection. The bridge
re-emits it to your browser as SSE — because **the browser cannot speak gRPC**. That hop
(Envoy or gRPC-Web in production) is the honest cost of choosing gRPC at the edge, and it is
why most systems keep gRPC internal.

## Statelessness and why it is a protocol-shaped decision

HTTP is stateless: each request carries everything needed to serve it. That is what lets any
of ten servers answer, lets you scale horizontally, and lets a CDN answer for you. Designs that
smuggle in state — server-side sessions keyed by cookie, a cursor that means "the next page of
whatever you asked last time" — trade that away for convenience. Sometimes worth it. Never free.

## The transferable rule

When you evaluate any protocol, ask these five questions:

1. **Who can speak it?** (browser? mobile? a partner's 2009 SOAP stack?)
2. **What does it give me for free?** (caching, retries, status semantics, streaming)
3. **What does it cost per message?** (bytes, parse time, connection setup)
4. **What does it make impossible?** (browser-native gRPC; HTTP caching for GraphQL)
5. **What operational tooling exists?** (curl, proxies, CDNs, dashboards, tracing)

## What you should now be able to do

- [ ] Explain why REST gets caching "free" and GraphQL does not.
- [ ] Say what HTTP/2 changed and why gRPC requires it.
- [ ] Quote your *own* measured numbers for round trips and bytes across the three styles.
- [ ] Argue against "protocol X is faster" using the round-trips-vs-bytes distinction.

**Artifact for this module:** run the benchmark, record your numbers, and write half a page:
which style wins for a mobile client on 4G, which for a service-to-service call on the same
LAN, and why the answer differs. Include the caveat about localhost measurements.

Next: [Lesson 5 — The API design process](05-the-design-process.md)
