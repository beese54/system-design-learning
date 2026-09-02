// LAB 3 - the gRPC server. Run it in its own terminal:  npm run grpc
//
// It speaks HTTP/2 + protobuf on 127.0.0.1:50051. Open that URL in a browser
// and you get nothing useful - that is the point of the lab, not a bug.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import {
  findArtist, albumsOfArtist, tracksOfAlbum, playEvents, artists
} from '../shared/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROTO_PATH = join(HERE, 'catalog.proto');

// proto-loader turns the .proto into runtime stubs. In Go/Java/C++ this is a
// build step (protoc) that emits real classes - same contract either way.
export const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, longs: String, enums: String, defaults: true, oneofs: true
});
export const proto = grpc.loadPackageDefinition(packageDefinition).riff.catalog.v1;

const toTrack = (t) => ({ id: t.id, title: t.title, seconds: t.seconds, plays: t.plays });
const toAlbum = (b, withTracks) => ({
  id: b.id, artistId: b.artistId, title: b.title, year: b.year, artwork: b.artwork,
  tracks: withTracks ? tracksOfAlbum(b.id).map(toTrack) : []
});

const handlers = {
  GetArtist: (call, cb) => {
    const a = findArtist(call.request.id);
    // gRPC has its own status codes. NOT_FOUND (5) is not HTTP 404 - the two
    // vocabularies merely rhyme. Mapping between them is real design work.
    if (!a) return cb({ code: grpc.status.NOT_FOUND, message: 'no artist ' + call.request.id });
    cb(null, { id: a.id, name: a.name, country: a.country, formed: a.formed, bio: a.bio });
  },

  ListAlbums: (call, cb) => {
    const rows = albumsOfArtist(call.request.artistId);
    cb(null, { albums: rows.map(b => toAlbum(b, call.request.includeTracks)) });
  },

  AddArtist: (call, cb) => {
    if (!call.request.name) {
      return cb({ code: grpc.status.INVALID_ARGUMENT, message: 'name is required' });
    }
    const created = {
      id: 'a' + (artists.length + 1),
      name: call.request.name,
      country: call.request.country || 'XX',
      formed: call.request.formed || new Date().getFullYear(),
      bio: call.request.bio || ''
    };
    artists.push(created);
    cb(null, created);
  },

  // One call, many responses, one connection. The client sees events arrive
  // as they happen instead of polling a REST endpoint every second.
  WatchPlays: (call) => {
    const limit = Math.min(call.request.limit || 8, 50);
    const events = [...playEvents(limit)];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= events.length || call.cancelled) {
        clearInterval(timer);
        return call.end();
      }
      call.write(events[i++]);
    }, 400);
    call.on('cancelled', () => clearInterval(timer));
  }
};

export function startGrpcServer(port = 50051) {
  const server = new grpc.Server();
  server.addService(proto.CatalogService.service, handlers);
  return new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:' + port, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      console.log('[grpc]  CatalogService listening on 127.0.0.1:' + boundPort + ' (HTTP/2, protobuf)');
      resolve(server);
    });
  });
}

// Only start when run directly, so the lab host can import the stubs safely.
if (process.argv[1] && process.argv[1].endsWith('server.js') && process.argv[1].includes('grpc')) {
  startGrpcServer(Number(process.env.GRPC_PORT || 50051));
}
