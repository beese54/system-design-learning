# Solutions

Try the exercises first. Every snippet below was applied to a copy of `labs/` and run — the
outputs quoted are real.

Not the only correct answers. Where a choice was arguable, the reasoning is in the comments.

---

## 0 · Shared data (all three labs)

`labs/shared/catalog.js` — add the playlists and two helpers:

```js
export const playlists = [
  { id: 'p1', name: 'Late shift',   owner: 'ada', createdAt: '2026-02-11T09:12:00Z', trackIds: ['t6','t1','t10'] },
  { id: 'p2', name: 'Slow morning', owner: 'ada', createdAt: '2026-03-02T07:40:00Z', trackIds: ['t8','t3'] }
];

export const findPlaylist     = (id) => playlists.find(p => p.id === id) || null;
// Playlist order is DATA, not a sort: map ids -> tracks and keep the client's order.
export const tracksOfPlaylist = (pl) => pl.trackIds.map(id => findTrack(id)).filter(Boolean);
```

That comment is the whole design insight of this exercise. A playlist is not "the tracks
matching a filter" — the ordering is user intent, so it is stored, returned and patched as a
list of ids.

---

## §REST

`labs/rest/api.js` — a document builder beside the others:

```js
function playlistDoc(pl, url) {
  countRead();
  const doc = {
    id: pl.id, type: 'playlist', name: pl.name, owner: pl.owner,
    createdAt: pl.createdAt,
    trackCount: pl.trackIds.length,          // a count, not the tracks: keep the resource small
    _links: {
      self:   link(BASE + '/playlists/' + pl.id),
      tracks: link(BASE + '/playlists/' + pl.id + '/tracks')
    }
  };
  return pick(doc, url.searchParams.get('fields'));
}
```

The collection and creation:

```js
if (seg[0] === 'playlists' && seg.length === 1) {
  if (m === 'GET') {
    const owner = url.searchParams.get('owner');
    const rows = playlists.filter(pl => !owner || pl.owner === owner).map(pl => playlistDoc(pl, url));
    return maybe304(req, res, paginate(rows, url, BASE + '/playlists'));
  }

  if (m === 'POST') {
    const body = await readBody(req);
    if (body === Symbol.for('bad-json')) {
      return problem(res, 400, 'Malformed JSON', 'Request body was not valid JSON.');
    }

    const errors = [];
    if (!body || !body.name) errors.push({ field: 'name', issue: 'required' });
    const ids = (body && body.trackIds) || [];
    if (!Array.isArray(ids)) errors.push({ field: 'trackIds', issue: 'must be an array of track ids' });
    else ids.forEach((id, i) => {
      if (!findTrack(id)) errors.push({ field: 'trackIds[' + i + ']', issue: 'unknown track "' + id + '"' });
    });
    // Validate everything BEFORE mutating anything: a rejected request must leave no trace.
    if (errors.length) {
      return problem(res, 422, 'Validation failed', 'One or more fields were rejected.', { errors });
    }

    const key = req.headers['idempotency-key'];
    if (key && idem.has(key)) {
      const existing = findPlaylist(idem.get(key));
      if (existing) {
        return send(res, 200, playlistDoc(existing, url), {
          Location: BASE + '/playlists/' + existing.id, 'Idempotent-Replay': 'true'
        });
      }
    }

    const created = {
      id: 'p' + (playlists.length + 1),
      name: body.name,
      owner: body.owner || 'anonymous',
      createdAt: new Date().toISOString(),
      trackIds: ids
    };
    playlists.push(created);
    if (key) idem.set(key, created.id);
    return send(res, 201, playlistDoc(created, url), { Location: BASE + '/playlists/' + created.id });
  }

  return send(res, 405, { title: 'Method not allowed', status: 405 }, { Allow: 'GET, POST' });
}
```

The item, its sub-collection, and optimistic locking:

```js
if (seg[0] === 'playlists' && seg.length >= 2) {
  const pl = findPlaylist(seg[1]);
  if (!pl) return problem(res, 404, 'Playlist not found', 'No playlist with id "' + seg[1] + '".');

  if (seg.length === 2) {
    if (m === 'GET') return maybe304(req, res, playlistDoc(pl, url));

    if (m === 'PATCH') {
      const body = await readBody(req);
      if (body === Symbol.for('bad-json')) {
        return problem(res, 400, 'Malformed JSON', 'Request body was not valid JSON.');
      }
      // Optimistic locking: if the client says which version it edited, refuse
      // to clobber a newer one. Worth it when two people can edit one thing.
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch !== etagOf(playlistDoc(pl, url))) {
        return problem(res, 412, 'Precondition failed', 'The playlist changed since you read it.');
      }
      Object.assign(pl, pick(body || {}, 'name,owner,trackIds'));
      return send(res, 200, playlistDoc(pl, url));
    }

    if (m === 'DELETE') {
      playlists.splice(playlists.indexOf(pl), 1);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    return send(res, 405, { title: 'Method not allowed', status: 405 }, { Allow: 'GET, PATCH, DELETE' });
  }

  if (seg[2] === 'tracks' && m === 'GET') {
    const rows = tracksOfPlaylist(pl).map(t => trackDoc(t, url));   // playlist order preserved
    return maybe304(req, res, paginate(rows, url, BASE + '/playlists/' + pl.id + '/tracks'));
  }
}
```

Verified behaviour:

```
POST (new, Idempotency-Key: k1)      → 201 Created   Location: /rest/v1/playlists/p3
POST (repeat, same key)              → 200 OK        Idempotent-Replay: true
POST {"trackIds":["nope"]}           → 422 { errors: [{ field:"trackIds[0]", issue:'unknown track "nope"' }] }
PUT  /playlists                      → 405 Allow: GET, POST
DELETE /playlists/p2 then again      → 204, then 404
GET  /playlists/p1/tracks            → t6, t1, t10   (playlist order, not id order)
GET  /playlists?limit=1              → page.next = "/rest/v1/playlists?limit=1&cursor=cDE"
```

**Discussion points**

- `trackCount` instead of the tracks: the item resource stays small and cacheable; the tracks
  have their own URL. Returning them inline would have been a compound document — fine as an
  `?expand=tracks` option, not as the default.
- `422`, not `400`: the JSON parsed fine; the *values* were wrong.
- Validate-then-mutate: a request that fails must not half-create anything.
- `412` on a stale `If-Match` is worth it for multi-editor resources and overkill for a
  single-owner one. Decide, then write it down.

---

## §GraphQL

`labs/graphql/schema.js` — schema:

```graphql
"A user-curated, ordered list of tracks."
type Playlist {
  id: ID!
  name: String!
  owner: String!
  createdAt: String!
  "Tracks in playlist order - the order is data, not a sort."
  tracks: [Track!]!
  "Derived on the server so no two clients can disagree about it."
  totalSeconds: Int!
}

input NewPlaylist { name: String!, owner: String = "anonymous", trackIds: [ID!] = [] }

# added to Query
playlist(id: ID!): Playlist
playlists(owner: String): [Playlist!]!

# added to Mutation
createPlaylist(input: NewPlaylist!): Playlist!
```

Model and resolvers:

```js
class PlaylistModel {
  constructor(pl, ctx) { this.pl = pl; this.ctx = ctx; countRead(); }
  get id() { return this.pl.id; }
  get name() { return this.pl.name; }
  get owner() { return this.pl.owner; }
  get createdAt() { return this.pl.createdAt; }
  // Only runs if the client selected it. That laziness is the whole point.
  tracks() { return tracksOfPlaylist(this.pl).map(t => new TrackModel(t, this.ctx)); }
  totalSeconds() { return tracksOfPlaylist(this.pl).reduce((n, t) => n + t.seconds, 0); }
}
```

```js
playlist: ({ id }) => {
  const pl = findPlaylist(id);
  return pl ? new PlaylistModel(pl, ctx) : null;
},
playlists: ({ owner }) =>
  playlists.filter(pl => !owner || pl.owner === owner).map(pl => new PlaylistModel(pl, ctx)),
createPlaylist: ({ input }) => {
  if (!input.name.trim()) throw new Error('name must not be empty');
  const unknown = (input.trackIds || []).filter(id => !findTrack(id));
  if (unknown.length) throw new Error('unknown track ids: ' + unknown.join(', '));
  const created = {
    id: 'p' + (playlists.length + 1),
    name: input.name, owner: input.owner || 'anonymous',
    createdAt: new Date().toISOString(), trackIds: input.trackIds || []
  };
  playlists.push(created);
  return new PlaylistModel(created, ctx);
}
```

Verified behaviour — this is the number that matters:

```
{ playlist(id:"p1"){ name } }                          → X-Lab-Reads: 1
{ playlist(id:"p1"){ name totalSeconds tracks{title} } } → X-Lab-Reads: 4
```

One query asked for less and the server *did* less. No REST endpoint gives you that without a
`?fields=` parameter you had to design, document and maintain.

And the error case:

```
mutation { createPlaylist(input:{name:" "}){ id } }
→ HTTP 200
  { "data": null, "errors": [ { "message": "name must not be empty", "path": ["createPlaylist"] } ] }
```

HTTP `200` on a failed mutation. Your alerting must read bodies. If you only page on `5xx`,
this failure is invisible.

**Discussion points**

- `totalSeconds` on the server, not the client: two clients computing it will eventually
  disagree, and users will file the bug against you.
- Adding `Track.playlists` creates a cycle (`playlist → tracks → playlists → …`). Legal, useful,
  and precisely why the depth rule in `api.js` exists.
- A thrown resolver error becomes a `message` in `errors`. In production, map known failures to
  typed error codes in `extensions` and never let a raw exception message reach a client.

---

## §gRPC

`labs/grpc/catalog.proto`:

```proto
message Playlist {
  string id             = 1;
  string name           = 2;
  string owner          = 3;
  string created_at     = 4;
  repeated Track tracks = 5;
  int32  total_seconds  = 6;
  // reserved 7;   // <- how you retire a tag so it can never be reused
}

message GetPlaylistRequest    { string id = 1; }
message CreatePlaylistRequest { string name = 1; string owner = 2; repeated string track_ids = 3; }
message WatchPlaylistRequest  { string id = 1; }

service CatalogService {
  // …existing RPCs…
  rpc GetPlaylist    (GetPlaylistRequest)    returns (Playlist);
  rpc CreatePlaylist (CreatePlaylistRequest) returns (Playlist);
  rpc WatchPlaylist  (WatchPlaylistRequest)  returns (stream Track);
}
```

`labs/grpc/server.js`:

```js
const toPlaylist = (pl) => ({
  id: pl.id, name: pl.name, owner: pl.owner, createdAt: pl.createdAt,
  tracks: tracksOfPlaylist(pl).map(toTrack),
  totalSeconds: tracksOfPlaylist(pl).reduce((n, t) => n + t.seconds, 0)
});

GetPlaylist: (call, cb) => {
  const pl = findPlaylist(call.request.id);
  if (!pl) return cb({ code: grpc.status.NOT_FOUND, message: 'no playlist ' + call.request.id });
  cb(null, toPlaylist(pl));
},

CreatePlaylist: (call, cb) => {
  const { name, owner, trackIds = [] } = call.request;
  if (!name || !name.trim()) {
    return cb({ code: grpc.status.INVALID_ARGUMENT, message: 'name is required' });
  }
  const unknown = trackIds.filter(id => !findTrack(id));
  if (unknown.length) {
    return cb({ code: grpc.status.NOT_FOUND, message: 'unknown track ids: ' + unknown.join(', ') });
  }
  const created = { id: 'p' + (playlists.length + 1), name, owner: owner || 'anonymous',
                    createdAt: new Date().toISOString(), trackIds };
  playlists.push(created);
  cb(null, toPlaylist(created));
},

WatchPlaylist: (call) => {
  const pl = findPlaylist(call.request.id);
  if (!pl) return call.destroy({ code: grpc.status.NOT_FOUND, message: 'no playlist' });
  const rows = tracksOfPlaylist(pl);
  let i = 0;
  const timer = setInterval(() => {
    if (i >= rows.length || call.cancelled) { clearInterval(timer); return call.end(); }
    call.write(toTrack(rows[i++]));
  }, 1000);
  call.on('cancelled', () => clearInterval(timer));   // stop work nobody is waiting for
}
```

Verified run:

```
GetPlaylist p1        → { tracks: [Harbour Lights, Signal Hill, Accra Nights], … }
CreatePlaylist "" …   → code 3   (INVALID_ARGUMENT)
CreatePlaylist trackIds:["zz"] → code 5 (NOT_FOUND)
Playlist p1 on the wire → 129 protobuf bytes vs 312 as JSON  (59 % smaller)
WatchPlaylist p1      → tracks streamed one per second; client cancel stops the server timer
```

Status mapping for the bridge — do this in **one** place, not per route:

```js
const HTTP_FOR = {
  [grpc.status.OK]:                  200,
  [grpc.status.INVALID_ARGUMENT]:    400,
  [grpc.status.UNAUTHENTICATED]:     401,
  [grpc.status.PERMISSION_DENIED]:   403,
  [grpc.status.NOT_FOUND]:           404,
  [grpc.status.ALREADY_EXISTS]:      409,
  [grpc.status.FAILED_PRECONDITION]: 422,
  [grpc.status.RESOURCE_EXHAUSTED]:  429,
  [grpc.status.DEADLINE_EXCEEDED]:   504,
  [grpc.status.UNAVAILABLE]:         503
};
```

**Discussion points**

- `NOT_FOUND` for an unknown track id inside a create is arguable — `INVALID_ARGUMENT` is
  defensible too. What is *not* defensible is choosing differently in each RPC. Pick a rule,
  document it, apply it everywhere.
- `reserved 7;` prevents the worst protobuf bug there is: a new field reusing an old tag, so
  an old client's bytes land in a new field with a different meaning and no error anywhere.
- The cancellation handler is not decoration. Without it the server keeps producing for a
  client that hung up — which is how a "slow service" incident actually starts.

---

## §Design answers

**D3 · Evolution drill**

| Change | REST | GraphQL | gRPC |
|---|---|---|---|
| rename `name` → `title` | **breaking** (new version, or add `title` and deprecate `name`) | **breaking** (add `title`, `@deprecated` on `name`, measure usage, then remove) | **safe on the wire** (tags unchanged) but breaking for generated code — coordinate |
| add `isPublic: Boolean` | safe | safe (nobody selects it unasked) | safe (new tag) |
| make `owner` required | **breaking** (old clients fail validation) | **breaking** (`String` → `String!` on an input) | **breaking** in practice — proto3 cannot enforce it, so it becomes a runtime rejection |
| `createdAt` string → int | **breaking** (type change) | **breaking** | **breaking and dangerous** — never change a tag's type; add a new tag and reserve the old |
| remove `totalSeconds` | **breaking** | breaking, but you can *prove* who uses it with field-level stats first | breaking; `reserved` the tag forever |

The row worth remembering: only GraphQL lets you measure per-field usage before deleting.
That is the strongest operational argument in its favour.
