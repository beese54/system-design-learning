// LAB 2 - the GraphQL transport.
//
// Notice how little there is here. GraphQL is not an HTTP protocol; it is a
// query language that usually *rides* HTTP as a single POST to a single URL.
// That is why almost every HTTP feature you tuned in Lab 1 - status codes,
// ETags, per-URL caching - stops helping you here. You trade them for the
// client deciding the response shape.
import { parse, validate, execute, specifiedRules, GraphQLError } from 'graphql';
import { schema, makeContext, makeRoot, typeDefs } from './schema.js';
import { send } from '../shared/http.js';
import { resetReads } from '../shared/catalog.js';

// A query language is an attack surface: a client can ask for
// artist -> albums -> artist -> albums ... forever. Depth limiting is the
// cheapest guard; production servers add cost analysis and persisted queries.
const MAX_DEPTH = 8;
function depthRule(context) {
  let depth = 0;
  return {
    Field: {
      enter() {
        depth++;
        if (depth > MAX_DEPTH) {
          context.reportError(new GraphQLError('Query is deeper than the limit of ' + MAX_DEPTH + '.'));
        }
      },
      leave() { depth--; }
    }
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

export async function handleGraphQL(req, res, url) {
  if (url.pathname !== '/graphql') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    });
    return res.end();
  }

  // Convenience for the lab: GET /graphql?sdl=1 returns the raw schema text.
  if (req.method === 'GET' && url.searchParams.get('sdl')) {
    return send(res, 200, { sdl: typeDefs.trim() });
  }

  const raw = req.method === 'POST' ? await readBody(req) : '{}';
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return send(res, 400, { errors: [{ message: 'Request body was not valid JSON.' }] });
  }

  const source = payload.query || url.searchParams.get('query') || '';
  if (!source.trim()) {
    return send(res, 400, { errors: [{ message: 'No query supplied.' }] });
  }

  resetReads();
  let document;
  try {
    document = parse(source);                       // 1. syntax
  } catch (err) {
    // A GraphQL error is data, not an HTTP failure: the transport succeeded.
    return send(res, 200, { errors: [{ message: err.message, locations: err.locations }] });
  }

  const errors = validate(schema, document, [...specifiedRules, depthRule]); // 2. schema check
  if (errors.length) {
    return send(res, 200, { errors: errors.map(e => ({ message: e.message, locations: e.locations })) });
  }

  const ctx = makeContext({ batch: url.searchParams.get('batch') === '1' });
  const result = await execute({                    // 3. run the resolvers
    schema,
    document,
    rootValue: makeRoot(ctx),
    variableValues: payload.variables || {},
    operationName: payload.operationName || null
  });

  // The signature move of GraphQL: partial success. `data` and `errors` can
  // both be present, because one failed field does not fail the request.
  const body = {};
  if (result.data !== undefined) body.data = result.data;
  if (result.errors) {
    body.errors = result.errors.map(e => ({ message: e.message, path: e.path, locations: e.locations }));
  }
  return send(res, 200, body);
}
