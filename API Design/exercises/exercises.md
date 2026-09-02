# Exercises

Each exercise has **acceptance criteria** — checkable statements, not vibes. Try before you
read [`solutions.md`](solutions.md); the value is in the attempt.

The running feature across all three labs is the same: **playlists**. A playlist has an id, a
name, an owner, a created timestamp, and an ordered list of track ids. Building it three times
is the point — you will feel exactly where each style makes you work.

Start the labs first:

```bash
cd "API Design/labs" && npm install && npm start
```

---

## Warm-ups (30 minutes, no code)

**W1 · Read the wire.** In the REST tab, click *collection, paginated*, then tick
*send If-None-Match* and click it again.
- [ ] I can explain, in one sentence each, what `ETag`, `Cache-Control` and `304` did.
- [ ] I can state how many bytes the second response carried.

**W2 · Break something on purpose.** POST an artist with `{"country": "usa"}`.
- [ ] I can explain why this is `422` and not `400`, and when it *would* be `400`.

**W3 · Feel the N+1.** In the GraphQL tab run *two resources, one round trip* with batching
off, note *datastore reads*, then tick batching and run it again.
- [ ] I can state both numbers and explain the difference to someone who has never heard of
      DataLoader.

**W4 · Meet the bad design.** Click the red *the BAD design* button.
- [ ] I can list four separate design failures in that one response.

---

## §REST — add a playlists resource

Edit `labs/shared/catalog.js` (add a `playlists` array) and `labs/rest/api.js`.

1. `GET /rest/v1/playlists` — paginated collection, `?owner=` filter.
2. `GET /rest/v1/playlists/{id}` — one playlist, with `_links` to itself and its tracks.
3. `GET /rest/v1/playlists/{id}/tracks` — the tracks, in playlist order (not track-id order).
4. `POST /rest/v1/playlists` — create.
5. `PATCH /rest/v1/playlists/{id}` — rename, or reorder tracks.
6. `DELETE /rest/v1/playlists/{id}`.

**Acceptance criteria**
- [ ] `POST` with a valid body returns `201` **and** a `Location` header pointing at the new resource
- [ ] `POST` with a missing `name` returns `422` with a field-level `errors` array in problem+json
- [ ] `POST` with a `trackIds` entry that does not exist returns `422`, and creates nothing
- [ ] Repeating a `POST` with the same `Idempotency-Key` returns the first playlist, not a second one
- [ ] `GET` of one playlist returns an `ETag`; repeating with `If-None-Match` returns `304` and zero body bytes
- [ ] `DELETE` returns `204` with no body; a second `DELETE` returns `404`
- [ ] `GET /playlists?limit=1` returns a `page.next` link that works when followed
- [ ] Wrong method on the collection returns `405` with an `Allow` header
- [ ] `GET /playlists/{id}/tracks` preserves playlist order

**Stretch:** add `If-Match` optimistic locking on `PATCH` — a stale ETag gets `412 Precondition
Failed`. Explain when you would want this and when it is overkill.

---

## §GraphQL — add playlists to the graph

Edit `labs/graphql/schema.js`.

1. A `Playlist` type: `id`, `name`, `owner`, `createdAt`, `tracks: [Track!]!`, `totalSeconds: Int!`.
2. `Query.playlist(id: ID!)` and `Query.playlists(owner: String)`.
3. `Mutation.createPlaylist(input: NewPlaylist!): Playlist!`.
4. Add `Track.playlists: [Playlist!]!` so the graph has a cycle — then notice what that does to
   your depth limit.

**Acceptance criteria**
- [ ] The SDL button shows the new types with descriptions on every field
- [ ] A query asking for only `{ playlist(id:"p1"){ name } }` resolves **no** track data
      (check the *datastore reads* metric — laziness is the feature)
- [ ] `totalSeconds` is computed on the server, so two clients cannot disagree
- [ ] A query fetching three playlists and their tracks shows a lower read count with batching on
- [ ] Requesting a non-existent field returns HTTP `200` with an `errors` array
- [ ] `createPlaylist` with an empty name returns an error and creates nothing
- [ ] A deliberately deep cyclic query (`playlist → tracks → playlists → tracks …`) is rejected
      by the depth rule

**Stretch:** add `@deprecated` to a field and explain how you would prove nobody uses it before
deleting it.

---

## §gRPC — add playlists to the service

Edit `labs/grpc/catalog.proto` and `labs/grpc/server.js`, then expose it through
`labs/grpc/bridge.js`.

1. `Playlist` message with correctly numbered fields.
2. `rpc GetPlaylist (GetPlaylistRequest) returns (Playlist);`
3. `rpc CreatePlaylist (CreatePlaylistRequest) returns (Playlist);` — return
   `INVALID_ARGUMENT` for an empty name and `NOT_FOUND` for an unknown track id.
4. `rpc WatchPlaylist (WatchPlaylistRequest) returns (stream Track);` — stream the tracks one
   per second, as a stand-in for a live queue.

**Acceptance criteria**
- [ ] `npm run grpc` starts without loader errors and the bridge returns real data
- [ ] Creating with an empty name yields gRPC status `INVALID_ARGUMENT (3)`, and the bridge maps
      it to HTTP `400` (not `500`)
- [ ] The bridge reports `protobufBytes` and `jsonBytes` for `Playlist`; I can state the % saved
- [ ] The streaming RPC delivers tracks over time on one connection, and cancelling the browser
      request actually stops the server work
- [ ] I added a field, removed it, and marked its tag `reserved` — and can explain the failure
      mode that prevents

**Stretch:** map every gRPC status your service can return to an HTTP status in the bridge, in
one place. That mapping table is a real design artifact.

---

## §Design — the parts with no code

**D1 · Contract first.** Before writing any of the above, write the playlist contract three
ways: an OpenAPI path snippet, SDL, and a `.proto` message. Note which one forced you to decide
something the others let you postpone.

**D2 · Break-it review.** Run [`../worksheets/design-review-checklist.md`](../worksheets/design-review-checklist.md)
over your own playlist API. Fix every unticked box or write down why you accept it.

**D3 · The evolution drill.** For each change, say whether it is additive or breaking, in all
three styles:
1. rename `name` to `title`
2. add `isPublic: Boolean`
3. make `owner` required
4. change `createdAt` from a date string to a unix integer
5. remove `totalSeconds`

**D4 · Decision record.** Complete
[`../worksheets/protocol-decision-worksheet.md`](../worksheets/protocol-decision-worksheet.md)
for a real boundary at work (or a project you want to build). One page, defensible in a year.

---

## Self-check: are you done?

- [ ] Playlists work in all three labs, from the visual UI
- [ ] I can state, with my own measured numbers, the round trips and bytes each style needed
- [ ] I can name the specific thing each style made hard, from having felt it
- [ ] I produced a completed API Design Canvas and a decision record

If all four are ticked, you did not read an API course — you built one.
