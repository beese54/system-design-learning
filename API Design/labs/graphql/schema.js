// LAB 2 - the GraphQL schema.
//
// In REST the *server* decided the shape of every response. Here the server
// publishes a type graph and the *client* decides the shape, one query at a
// time. The schema below is the entire contract - there is no second document
// to keep in sync, and clients can introspect it at runtime.
import { buildSchema } from 'graphql';
import {
  artists, findArtist, findAlbum, findTrack,
  albumsOfArtist, tracksOfAlbum, countRead, counters
} from '../shared/catalog.js';

export const typeDefs = /* GraphQL */ `
  "A recording artist."
  type Artist {
    id: ID!
    name: String!
    country: String!
    formed: Int!
    bio: String!
    "Albums by this artist, newest first when sort = YEAR_DESC."
    albums(sort: AlbumSort = YEAR_DESC): [Album!]!
  }

  type Album {
    id: ID!
    title: String!
    year: Int!
    artwork: String!
    artist: Artist!
    tracks: [Track!]!
    "Server-side derived field. Deriving it here means every client agrees."
    runtimeSeconds: Int!
  }

  type Track {
    id: ID!
    title: String!
    seconds: Int!
    plays: Int!
    album: Album!
  }

  enum AlbumSort { YEAR_ASC YEAR_DESC TITLE }

  type Query {
    artist(id: ID!): Artist
    artists(country: String): [Artist!]!
    album(id: ID!): Album
    track(id: ID!): Track
    "Lab instrumentation: how many datastore reads this request has cost so far."
    _reads: Int!
  }

  input NewArtist {
    name: String!
    country: String = "XX"
    formed: Int
    bio: String = ""
  }

  type Mutation {
    "Mutations are just fields on a second root type - the only real difference is that they run in series."
    addArtist(input: NewArtist!): Artist!
  }
`;

export const schema = buildSchema(typeDefs);

// --- models -------------------------------------------------------------
// Each class is one node in the type graph. A field is only resolved if the
// client actually asked for it - that laziness is what kills over-fetching.
class TrackModel {
  constructor(t, ctx) { this.t = t; this.ctx = ctx; countRead(); }
  get id() { return this.t.id; }
  get title() { return this.t.title; }
  get seconds() { return this.t.seconds; }
  get plays() { return this.t.plays; }
  album() { return new AlbumModel(findAlbum(this.t.albumId), this.ctx); }
}

class AlbumModel {
  constructor(b, ctx) { this.b = b; this.ctx = ctx; countRead(); }
  get id() { return this.b.id; }
  get title() { return this.b.title; }
  get year() { return this.b.year; }
  get artwork() { return this.b.artwork; }
  artist() { return new ArtistModel(findArtist(this.b.artistId), this.ctx); }
  tracks() { return this.ctx.tracksOf(this.b.id).map(t => new TrackModel(t, this.ctx)); }
  runtimeSeconds() { return this.ctx.tracksOf(this.b.id).reduce((n, t) => n + t.seconds, 0); }
}

class ArtistModel {
  constructor(a, ctx) { this.a = a; this.ctx = ctx; countRead(); }
  get id() { return this.a.id; }
  get name() { return this.a.name; }
  get country() { return this.a.country; }
  get formed() { return this.a.formed; }
  get bio() { return this.a.bio; }
  albums({ sort }) {
    const rows = [...this.ctx.albumsOf(this.a.id)];
    if (sort === 'YEAR_ASC') rows.sort((x, y) => x.year - y.year);
    else if (sort === 'TITLE') rows.sort((x, y) => x.title.localeCompare(y.title));
    else rows.sort((x, y) => y.year - x.year);
    return rows.map(b => new AlbumModel(b, this.ctx));
  }
}

// A per-request context. With `batch` on, repeated child lookups are served
// from a request-scoped cache - the idea behind DataLoader, in eight lines.
// Toggle it in the lab UI and watch the read counter collapse.
export function makeContext({ batch = false } = {}) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!batch) return fn();
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    batch,
    albumsOf: (artistId) => memo('albums:' + artistId, () => albumsOfArtist(artistId)),
    tracksOf: (albumId) => memo('tracks:' + albumId, () => tracksOfAlbum(albumId))
  };
}

export function makeRoot(ctx) {
  return {
    artist: ({ id }) => {
      const a = findArtist(id);
      return a ? new ArtistModel(a, ctx) : null;
    },
    artists: ({ country }) =>
      artists
        .filter(a => !country || a.country === country.toUpperCase())
        .map(a => new ArtistModel(a, ctx)),
    album: ({ id }) => {
      const b = findAlbum(id);
      return b ? new AlbumModel(b, ctx) : null;
    },
    track: ({ id }) => {
      const t = findTrack(id);
      return t ? new TrackModel(t, ctx) : null;
    },
    _reads: () => counters.reads,
    addArtist: ({ input }) => {
      const created = {
        id: 'a' + (artists.length + 1),
        name: input.name,
        country: input.country || 'XX',
        formed: input.formed || new Date().getFullYear(),
        bio: input.bio || ''
      };
      artists.push(created);
      return new ArtistModel(created, ctx);
    }
  };
}
