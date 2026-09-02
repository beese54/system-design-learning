// The lab host. One process serves the visual lab UI and all three APIs so
// you can compare them under identical conditions:
//
//   http://localhost:4000/            the visual API Lab (start here)
//   http://localhost:4000/rest/v1/... Lab 1  REST over HTTP/1.1
//   http://localhost:4000/graphql     Lab 2  GraphQL
//   http://localhost:4000/grpc/...    Lab 3  bridge to the gRPC service
//   http://localhost:4000/compare     the benchmark the UI charts
//
// Run:  npm install && npm start
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { handleRest } from './rest/api.js';
import { handleGraphQL } from './graphql/api.js';
import { handleGrpcBridge } from './grpc/bridge.js';
import { startGrpcServer } from './grpc/server.js';
import { send } from './shared/http.js';
import { counters, resetReads } from './shared/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// ---------------------------------------------------------------------------
// /compare - the honest benchmark behind the "which protocol" chart.
// Scenario: render one artist page = the artist, their albums, and every
// track on every album. Each style pays a different price for the same screen.
// ---------------------------------------------------------------------------
async function runComparison(origin) {
  const t = async (fn) => {
    const t0 = performance.now();
    const out = await fn();
    return { ...out, ms: Math.round((performance.now() - t0) * 100) / 100 };
  };
  const bytesOf = (r) => Number(r.headers.get('content-length') || 0);

  // 1. REST, done naively: one call per resource. This is the N+1 waterfall
  //    every mobile team eventually complains about.
  const restNaive = await t(async () => {
    let calls = 0, bytes = 0;
    const r1 = await fetch(origin + '/rest/v1/artists/a1'); calls++; bytes += bytesOf(r1); await r1.json();
    const r2 = await fetch(origin + '/rest/v1/artists/a1/albums'); calls++; bytes += bytesOf(r2);
    const albums = (await r2.json()).data;
    for (const b of albums) {
      const r3 = await fetch(origin + '/rest/v1/albums/' + b.id + '/tracks'); calls++; bytes += bytesOf(r3); await r3.json();
    }
    return { label: 'REST (naive)', calls, bytes };
  });

  // 2. REST with a compound document: fewer trips, chunkier and less cacheable.
  const restExpand = await t(async () => {
    let calls = 0, bytes = 0;
    const r1 = await fetch(origin + '/rest/v1/artists/a1'); calls++; bytes += bytesOf(r1); await r1.json();
    const r2 = await fetch(origin + '/rest/v1/artists/a1/albums'); calls++; bytes += bytesOf(r2);
    const albums = (await r2.json()).data;
    for (const b of albums) {
      const r3 = await fetch(origin + '/rest/v1/albums/' + b.id + '?expand=tracks'); calls++; bytes += bytesOf(r3); await r3.json();
    }
    return { label: 'REST (?expand)', calls, bytes };
  });

  // 3. GraphQL: one round trip, and only the four fields the screen renders.
  const gql = await t(async () => {
    const query = '{ artist(id:"a1"){ name albums { title year tracks { title seconds } } } }';
    const r = await fetch(origin + '/graphql?batch=1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query })
    });
    const bytes = bytesOf(r);
    await r.json();
    return { label: 'GraphQL', calls: 1, bytes };
  });

  // 4. gRPC: one call, binary payload. Bytes reported are the protobuf frame,
  //    not the JSON the bridge hands the browser.
  const rpc = await t(async () => {
    const r = await fetch(origin + '/grpc/albums/a1?tracks=1');
    const body = await r.json();
    if (!r.ok || !body.wire) return { label: 'gRPC (offline)', calls: 1, bytes: 0, note: body.fix || body.error };
    return { label: 'gRPC', calls: 1, bytes: body.wire.protobufBytes, jsonEquivalent: body.wire.jsonBytes };
  });

  return {
    scenario: 'Render one artist page: artist + albums + all tracks',
    results: [restNaive, restExpand, gql, rpc],
    readMe: 'calls = HTTP round trips. bytes = response payload over the wire. Fewer is not automatically better - read Lesson 09 before you pick.'
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost:' + PORT));
  resetReads();

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, if-none-match, idempotency-key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
      });
      return res.end();
    }

    if (url.pathname === '/compare') {
      return send(res, 200, await runComparison('http://127.0.0.1:' + PORT));
    }
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, reads: counters.reads, port: PORT });
    }

    // Each handler returns false when the path is not its business. They
    // return byte counts otherwise, so compare against false explicitly.
    if ((await handleGrpcBridge(req, res, url)) !== false) return;
    if ((await handleGraphQL(req, res, url)) !== false) return;
    if (url.pathname.startsWith('/rest')) {
      if ((await handleRest(req, res, url)) !== false) return;
      return send(res, 404, { error: 'No REST route at ' + url.pathname });
    }

    // static UI
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(HERE, 'ui', rel));
    if (!file.startsWith(join(HERE, 'ui'))) return send(res, 403, { error: 'nope' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') return send(res, 404, { error: 'Not found: ' + url.pathname });
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, async () => {
  console.log('\n  API Design Lab');
  console.log('  ------------------------------------------------');
  console.log('  Visual lab   http://localhost:' + PORT + '/');
  console.log('  REST         http://localhost:' + PORT + '/rest/v1/artists');
  console.log('  GraphQL      http://localhost:' + PORT + '/graphql  (POST)');
  console.log('  Compare      http://localhost:' + PORT + '/compare');
  try {
    await startGrpcServer(50051);
  } catch {
    console.log('[grpc]  port 50051 already in use - assuming a gRPC server is already running');
  }
  console.log('  ------------------------------------------------\n');
});
