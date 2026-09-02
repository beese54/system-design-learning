// LAB 1 - REST over HTTP/1.1, written with no framework so that every design
// decision (status code, header, URL shape) is visible in the code itself.
//
// Resource model:  artist 1--* album 1--* track
// Base path:       /rest/v1
// Errors:          RFC 9457 application/problem+json
// Caching:         strong ETag + If-None-Match -> 304 Not Modified
// Collections:     cursor pagination, filtering, sparse fieldsets
import { send, problem, etagOf, pick } from '../shared/http.js';
import {
  artists, findArtist, findAlbum, findTrack,
  albumsOfArtist, tracksOfAlbum, countRead
} from '../shared/catalog.js';

const BASE = '/rest/v1';
const idem = new Map();            // Idempotency-Key -> id created the first time

const link = (href) => ({ href });

function artistDoc(a, url) {
  countRead();
  const doc = {
    id: a.id, type: 'artist', name: a.name, country: a.country,
    formed: a.formed, bio: a.bio,
    _links: {
      self: link(BASE + '/artists/' + a.id),
      albums: link(BASE + '/artists/' + a.id + '/albums')
    }
  };
  return pick(doc, url.searchParams.get('fields'));
}

function albumDoc(b, url) {
  countRead();
  const doc = {
    id: b.id, type: 'album', title: b.title, year: b.year,
    artwork: b.artwork, artistId: b.artistId,
    _links: {
      self: link(BASE + '/albums/' + b.id),
      tracks: link(BASE + '/albums/' + b.id + '/tracks'),
      artist: link(BASE + '/artists/' + b.artistId)
    }
  };
  return pick(doc, url.searchParams.get('fields'));
}

function trackDoc(t, url) {
  countRead();
  const doc = {
    id: t.id, type: 'track', title: t.title, seconds: t.seconds,
    plays: t.plays, albumId: t.albumId,
    _links: { self: link(BASE + '/tracks/' + t.id) }
  };
  return pick(doc, url.searchParams.get('fields'));
}

// Cursor pagination. The cursor is opaque (base64) so clients cannot do
// arithmetic on it, which keeps us free to change the scheme later.
function paginate(rows, url, path) {
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 50);
  const cursor = url.searchParams.get('cursor');
  const start = cursor
    ? rows.findIndex(r => r.id === Buffer.from(cursor, 'base64url').toString()) + 1
    : 0;
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  const more = Boolean(last) && rows.indexOf(last) < rows.length - 1;
  return {
    data: page,
    page: {
      limit,
      next: more
        ? path + '?limit=' + limit + '&cursor=' + Buffer.from(last.id).toString('base64url')
        : null
    }
  };
}

// Conditional GET: if the client already holds this exact representation,
// answer 304 with no body at all. A cheap win most hand-rolled APIs skip.
function maybe304(req, res, body, extraHeaders = {}) {
  const etag = etagOf(body);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*'
    });
    res.end();
    return 0;
  }
  return send(res, 200, body, { ETag: etag, 'Cache-Control': 'public, max-age=60', ...extraHeaders });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return Symbol.for('bad-json');
  }
}

export async function handleRest(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // ---- deliberately BAD endpoint, kept for Lesson 03 ---------------------
  // Verb in the URL, always 200, dumps every field whether you need it or
  // not, no caching, failure hidden inside a "successful" response.
  if (p === '/rest/bad/getArtistData') {
    const a = findArtist(url.searchParams.get('id'));
    countRead();
    return send(res, 200, {
      status: a ? 'ok' : 'error',
      errorMessage: a ? '' : 'artist not found or something',
      data: a
        ? { ...a, albums: albumsOfArtist(a.id).map(b => ({ ...b, tracks: tracksOfAlbum(b.id) })) }
        : {}
    });
  }

  if (!p.startsWith(BASE)) return false;
  const seg = p.slice(BASE.length).split('/').filter(Boolean);

  // ---- /artists ----------------------------------------------------------
  if (seg.length === 1 && seg[0] === 'artists') {
    if (m === 'GET') {
      let rows = artists;
      const country = url.searchParams.get('country');
      if (country) rows = rows.filter(a => a.country === country.toUpperCase());
      return maybe304(req, res, paginate(rows.map(a => artistDoc(a, url)), url, BASE + '/artists'));
    }

    if (m === 'POST') {
      const body = await readBody(req);
      if (body === Symbol.for('bad-json')) {
        return problem(res, 400, 'Malformed JSON', 'Request body was not valid JSON.');
      }
      const errors = [];
      if (!body || !body.name) errors.push({ field: 'name', issue: 'required' });
      if (body && body.country && !/^[A-Z]{2}$/.test(body.country)) {
        errors.push({ field: 'country', issue: 'must be an ISO 3166-1 alpha-2 code' });
      }
      if (errors.length) {
        return problem(res, 422, 'Validation failed', 'One or more fields were rejected.', { errors });
      }

      // Idempotency: a retried POST carrying the same key returns the first
      // result instead of creating a second artist. This is what makes an
      // unsafe method survivable on a flaky network.
      const key = req.headers['idempotency-key'];
      if (key && idem.has(key)) {
        const existing = findArtist(idem.get(key));
        return send(res, 200, artistDoc(existing, url), {
          Location: BASE + '/artists/' + existing.id,
          'Idempotent-Replay': 'true'
        });
      }

      const created = {
        id: 'a' + (artists.length + 1),
        name: body.name,
        country: body.country || 'XX',
        formed: body.formed || new Date().getFullYear(),
        bio: body.bio || ''
      };
      artists.push(created);
      if (key) idem.set(key, created.id);
      return send(res, 201, artistDoc(created, url), { Location: BASE + '/artists/' + created.id });
    }

    return send(res, 405, { title: 'Method not allowed', status: 405 }, { Allow: 'GET, POST' });
  }

  // ---- /artists/:id and /artists/:id/albums ------------------------------
  if (seg[0] === 'artists' && seg.length >= 2) {
    const a = findArtist(seg[1]);
    if (!a) return problem(res, 404, 'Artist not found', 'No artist with id "' + seg[1] + '".');

    if (seg.length === 2) {
      if (m === 'GET') return maybe304(req, res, artistDoc(a, url));
      if (m === 'PATCH') {
        const body = await readBody(req);
        if (body === Symbol.for('bad-json')) {
          return problem(res, 400, 'Malformed JSON', 'Request body was not valid JSON.');
        }
        Object.assign(a, pick(body || {}, 'name,country,formed,bio'));
        return send(res, 200, artistDoc(a, url));
      }
      if (m === 'DELETE') {
        artists.splice(artists.indexOf(a), 1);
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      return send(res, 405, { title: 'Method not allowed', status: 405 }, { Allow: 'GET, PATCH, DELETE' });
    }

    if (seg[2] === 'albums' && m === 'GET') {
      const rows = albumsOfArtist(a.id).map(b => albumDoc(b, url));
      return maybe304(req, res, paginate(rows, url, BASE + '/artists/' + a.id + '/albums'));
    }
  }

  // ---- /albums/:id and /albums/:id/tracks --------------------------------
  if (seg[0] === 'albums' && seg.length >= 2) {
    const b = findAlbum(seg[1]);
    if (!b) return problem(res, 404, 'Album not found', 'No album with id "' + seg[1] + '".');

    if (seg.length === 2 && m === 'GET') {
      const doc = albumDoc(b, url);
      // ?expand=tracks is the compound-document escape hatch: it saves a
      // round trip and costs you a simple, cacheable representation.
      if (url.searchParams.get('expand') === 'tracks') {
        doc.tracks = tracksOfAlbum(b.id).map(t => trackDoc(t, url));
      }
      return maybe304(req, res, doc);
    }

    if (seg[2] === 'tracks' && m === 'GET') {
      const rows = tracksOfAlbum(b.id).map(t => trackDoc(t, url));
      return maybe304(req, res, paginate(rows, url, BASE + '/albums/' + b.id + '/tracks'));
    }
  }

  // ---- /tracks/:id -------------------------------------------------------
  if (seg[0] === 'tracks' && seg[1] && m === 'GET') {
    const t = findTrack(seg[1]);
    if (!t) return problem(res, 404, 'Track not found', 'No track with id "' + seg[1] + '".');
    return maybe304(req, res, trackDoc(t, url));
  }

  return problem(res, 404, 'Not found', 'No resource at ' + p + '.');
}
