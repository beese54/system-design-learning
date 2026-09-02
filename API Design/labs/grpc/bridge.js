// LAB 3 - the bridge, and the lesson hiding inside it.
//
// Your browser cannot call a gRPC service. It has no API for trailers, no
// control over HTTP/2 frames, and no protobuf codec. So every browser-facing
// gRPC system needs one of these in front of it: a gateway that terminates
// something the browser CAN speak (JSON/SSE here, gRPC-Web or Envoy in
// production) and re-emits it as gRPC.
//
// That extra hop is the honest cost of gRPC at the edge, and it is exactly
// why "gRPC for internal services, REST/GraphQL for the public edge" is the
// default shape of most modern systems.
import grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { proto, PROTO_PATH } from './server.js';
import { send } from '../shared/http.js';

let client = null;
function stub() {
  if (!client) {
    client = new proto.CatalogService('127.0.0.1:50051', grpc.credentials.createInsecure());
  }
  return client;
}

const call = (method, request) => new Promise((resolve, reject) => {
  const deadline = new Date(Date.now() + 2000);   // every gRPC call gets a deadline
  stub()[method](request, { deadline }, (err, reply) => (err ? reject(err) : resolve(reply)));
});

// Encode the same payload as protobuf so the UI can chart real wire sizes
// instead of quoting a blog post at you.
let root = null;
async function sizeOf(messageName, payload) {
  if (!root) root = await protobuf.load(PROTO_PATH);
  const Type = root.lookupType('riff.catalog.v1.' + messageName);
  const clean = Type.fromObject(JSON.parse(JSON.stringify(payload)));
  return {
    protobufBytes: Type.encode(clean).finish().length,
    jsonBytes: Buffer.byteLength(JSON.stringify(payload))
  };
}

const offline = (res, err) => send(res, 503, {
  error: 'gRPC service unreachable on 127.0.0.1:50051',
  detail: String(err && err.message || err),
  fix: 'Open a second terminal in labs/ and run:  npm run grpc'
});

export async function handleGrpcBridge(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/grpc')) return false;

  if (p === '/grpc/proto') {
    const { readFile } = await import('node:fs/promises');
    return send(res, 200, { proto: await readFile(PROTO_PATH, 'utf8') });
  }

  if (p.startsWith('/grpc/artist/')) {
    const id = p.split('/').pop();
    try {
      const reply = await call('GetArtist', { id });
      return send(res, 200, { reply, wire: await sizeOf('Artist', reply) });
    } catch (err) {
      if (err.code === grpc.status.NOT_FOUND) {
        return send(res, 404, { grpcCode: 'NOT_FOUND (5)', message: err.details || err.message });
      }
      return offline(res, err);
    }
  }

  if (p.startsWith('/grpc/albums/')) {
    const artistId = p.split('/').pop();
    try {
      const reply = await call('ListAlbums', { artistId, includeTracks: url.searchParams.get('tracks') === '1' });
      return send(res, 200, { reply, wire: await sizeOf('AlbumList', reply) });
    } catch (err) {
      return offline(res, err);
    }
  }

  // Server streaming, re-emitted to the browser as Server-Sent Events.
  if (p === '/grpc/watch') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 8), 25);
    let stream;
    try {
      stream = stub().WatchPlays({ limit });
    } catch (err) {
      return offline(res, err);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    stream.on('data', (ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n'));
    stream.on('end', () => { res.write('event: done\ndata: {}\n\n'); res.end(); });
    stream.on('error', (err) => {
      res.write('event: error\ndata: ' + JSON.stringify({ message: String(err.message || err) }) + '\n\n');
      res.end();
    });
    req.on('close', () => stream.cancel());
    return true;
  }

  return send(res, 404, { error: 'no bridge route at ' + p });
}
