/* API Design Lab - all interactivity, no dependencies.
   Everything here talks to the same origin that served this page, so what you
   see in the panels is a real HTTP exchange, not a mock. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ---------------------------------------------------------------- tabs -- */
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === b.dataset.tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

const metric = (label, value) => `<div class="metric"><b>${value}</b><span>${label}</span></div>`;
const statusClass = (s) => s >= 500 ? 'servererr' : s >= 400 ? 'clienterr' : s >= 300 ? 'redirect' : 'ok';
const headerDump = (res) => [...res.headers.entries()]
  .map(([k, v]) => k.padEnd(28) + v).join('\n');

/* ------------------------------------------------------------ anatomy -- */
$('#anRun').onclick = async () => {
  const packet = $('#anPacket');
  packet.classList.remove('fly'); void packet.offsetWidth; packet.classList.add('fly');

  $('#anReq').textContent =
`GET /rest/v1/artists/a1 HTTP/1.1
Host: localhost:4000
Accept: application/json

(no body - GET is safe: it asks, it never changes anything)`;

  const res = await fetch('/rest/v1/artists/a1');
  const body = await res.text();
  $('#anRes').textContent =
`HTTP/1.1 ${res.status} ${res.statusText}
${headerDump(res)}

${body}`;
};

/* ------------------------------------------------------- architecture -- */
const ARCH = {
  clients: {
    h: 'Client applications',
    p: 'They hold a copy of your contract, hard-coded, and they ship on their own schedule. A mobile app your users refuse to update is why "just change the endpoint" is never just.',
    rows: [['Talks to', 'the edge, never to services directly'], ['Cares about', 'round trips, payload size, offline behaviour'], ['Usual protocol', 'REST or GraphQL over HTTPS']]
  },
  partners: {
    h: 'Partner / third-party consumers',
    p: 'Named organisations integrating on a contract. They need stable versions, a deprecation policy with dates, sandbox credentials and webhooks for things they cannot poll for.',
    rows: [['Cost of a breaking change', 'contractual, sometimes legal'], ['Needs', 'versioning, changelog, sandbox, SLAs'], ['Usual protocol', 'REST + webhooks']]
  },
  edge: {
    h: 'The API gateway / edge',
    p: 'The one place where cross-cutting concerns belong: authentication, rate limiting, TLS termination, routing, request logging and version pinning. Push these into every service and you will implement them eight slightly different ways.',
    rows: [['Owns', 'auth, quotas, routing, observability'], ['Protocol translation', 'public REST/GraphQL in, gRPC out'], ['Failure here', 'takes down everything behind it']]
  },
  public: {
    h: 'A public-facing service',
    p: 'Its response shape is a published artifact. Design it around what clients need to accomplish, not around your table columns - because your tables will change and this shape cannot.',
    rows: [['Shape follows', 'client use cases'], ['Change policy', 'additive only; new version for breaks'], ['Usual protocol', 'REST, sometimes GraphQL']]
  },
  internal: {
    h: 'Internal services',
    p: 'Consumers are your own teams, deployable in lockstep, on a fast private network. That lets you choose strictness and speed over universal accessibility - which is the whole argument for gRPC.',
    rows: [['Consumers', 'other services you control'], ['Optimise for', 'latency, type safety, throughput'], ['Usual protocol', 'gRPC, or async events']]
  },
  data: {
    h: 'Data stores and other people’s APIs',
    p: 'Note the bottom-right box: Stripe’s API is someone else’s contract, and you are the client with the hard-coded assumptions. Every design rule on this page will one day be applied to you by someone reading your docs at 2 a.m.',
    rows: [['Never expose', 'your schema as your API shape'], ['Third-party APIs', 'wrap them; do not scatter their types'], ['Coupling risk', 'their outage becomes your outage']]
  }
};

$$('.arch-svg .hot').forEach(g => g.onclick = () => {
  $$('.arch-svg .hot').forEach(x => x.classList.toggle('sel', x === g));
  const d = ARCH[g.dataset.info];
  $('#archInfo').innerHTML =
    `<h3>${d.h}</h3><p>${d.p}</p><table class="mini">` +
    d.rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('') + '</table>';
});

/* ------------------------------------------------------------ lab: REST -- */
const REST_CALLS = [
  { m: 'GET', u: '/rest/v1/artists?limit=2', t: 'collection, paginated' },
  { m: 'GET', u: '/rest/v1/artists/a1', t: 'one resource' },
  { m: 'GET', u: '/rest/v1/artists/a1/albums', t: 'sub-collection' },
  { m: 'GET', u: '/rest/v1/albums/b1?expand=tracks', t: 'compound document' },
  { m: 'GET', u: '/rest/v1/artists/a1?fields=id,name', t: 'sparse fieldset' },
  { m: 'GET', u: '/rest/v1/artists?country=IE', t: 'filtered' },
  { m: 'GET', u: '/rest/v1/artists/nope', t: '404 problem+json' }
];
const REST_MECH = [
  { m: 'POST', u: '/rest/v1/artists', body: { name: 'Blue Harbour', country: 'PT' }, t: '201 + Location' },
  { m: 'POST', u: '/rest/v1/artists', body: { country: 'usa' }, t: '422 validation' },
  { m: 'POST', u: '/rest/v1/artists', body: { name: 'Retry Me' }, idem: 'demo-key-1', t: 'idempotent retry' },
  { m: 'PATCH', u: '/rest/v1/artists/a2', body: { bio: 'Edited from the lab.' }, t: 'partial update' },
  { m: 'GET', u: '/rest/bad/getArtistData?id=a1', t: 'the BAD design', bad: true }
];

let lastEtag = null;

function renderRestButtons(list, host) {
  host.innerHTML = '';
  list.forEach(c => {
    const b = document.createElement('button');
    if (c.bad) b.className = 'bad';
    b.innerHTML = `<span class="m ${c.m}">${c.m}</span>${esc(c.u.replace('/rest/v1', ''))}<br><span class="sub">${c.t}</span>`;
    b.onclick = () => restCall(c);
    host.appendChild(b);
  });
}
renderRestButtons(REST_CALLS, $('#restBtns'));
renderRestButtons(REST_MECH, $('#restMech'));

async function restCall(c) {
  const headers = {};
  if (c.body) headers['content-type'] = 'application/json';
  if (c.idem) headers['idempotency-key'] = c.idem;
  if ($('#restReuseEtag').checked && lastEtag && c.m === 'GET') headers['if-none-match'] = lastEtag;

  $('#restReq').textContent =
    `${c.m} ${c.u} HTTP/1.1\n` +
    Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') +
    (c.body ? `\n\n${JSON.stringify(c.body, null, 2)}` : '\n\n(no body)');

  const t0 = performance.now();
  const res = await fetch(c.u, { method: c.m, headers, body: c.body ? JSON.stringify(c.body) : undefined });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  if (res.headers.get('etag')) lastEtag = res.headers.get('etag');

  $('#restStatus').innerHTML =
    `<span class="pill ${statusClass(res.status)}">${res.status} ${res.statusText || ''}</span>` +
    (res.status === 304 ? ' <span class="hint">nothing sent - your cached copy is still valid</span>' : '') +
    (c.bad ? ' <span class="hint">200 OK… even when it failed. That is the bug.</span>' : '');

  $('#restMetrics').innerHTML =
    metric('bytes', text.length || 0) +
    metric('datastore reads', res.headers.get('x-lab-reads') ?? '-') +
    metric('ms', ms) +
    metric('cacheable', res.headers.get('etag') ? 'yes' : 'no');

  $('#restHeaders').textContent = headerDump(res) || '(none)';
  try { $('#restBody').textContent = JSON.stringify(JSON.parse(text), null, 2); }
  catch { $('#restBody').textContent = text || '(empty body)'; }
}

/* --------------------------------------------------------- lab: GraphQL -- */
const GQL_PRESETS = {
  'exactly what one screen needs': `{
  artist(id: "a1") {
    name
    albums { title year tracks { title seconds } }
  }
}`,
  'ask for less, get less': `{
  artist(id: "a1") { name }
}`,
  'two resources, one round trip': `{
  nova: artist(id: "a1") { name country }
  irish: artists(country: "IE") { name albums { title } }
}`,
  'arguments + aliases': `{
  artist(id: "a2") {
    name
    oldest: albums(sort: YEAR_ASC) { title year }
    alphabetical: albums(sort: TITLE) { title }
  }
}`,
  'mutation': `mutation {
  addArtist(input: { name: "Field Notes", country: "CA" }) { id name country }
}`,
  'a field that does not exist': `{
  artist(id: "a1") { name genre }
}`,
  'malicious deep query (rejected)': `{
  artist(id:"a1"){ albums { artist { albums { artist { albums { artist { name } } } } } } }
}`
};

const gqlHost = $('#gqlPresets');
Object.entries(GQL_PRESETS).forEach(([name, q]) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => { $('#gqlQuery').value = q; runGql(); };
  gqlHost.appendChild(b);
});

async function runGql() {
  const query = $('#gqlQuery').value;
  const t0 = performance.now();
  const res = await fetch('/graphql?batch=' + ($('#gqlBatch').checked ? '1' : '0'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query })
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }

  $('#gqlMetrics').innerHTML =
    metric('http status', res.status) +
    metric('bytes', text.length) +
    metric('datastore reads', res.headers.get('x-lab-reads') ?? '-') +
    metric('ms', ms) +
    metric('errors', parsed && parsed.errors ? parsed.errors.length : 0) +
    metric('round trips', 1);
  $('#gqlBody').textContent = parsed ? JSON.stringify(parsed, null, 2) : text;
}
$('#gqlRun').onclick = runGql;
$('#gqlSdl').onclick = async () => {
  const r = await fetch('/graphql?sdl=1');
  $('#gqlBody').textContent = (await r.json()).sdl;
  $('#gqlMetrics').innerHTML = metric('the whole contract', 'SDL');
};

/* ------------------------------------------------------------ lab: gRPC -- */
const GRPC_CALLS = [
  { u: '/grpc/artist/a1', t: 'GetArtist (unary)', msg: 'Artist' },
  { u: '/grpc/albums/a1?tracks=1', t: 'ListAlbums + tracks', msg: 'AlbumList' },
  { u: '/grpc/albums/a3', t: 'ListAlbums, no tracks', msg: 'AlbumList' },
  { u: '/grpc/artist/nope', t: 'NOT_FOUND (status 5)', msg: '-' }
];
GRPC_CALLS.forEach(c => {
  const b = document.createElement('button');
  b.innerHTML = `<span class="m GET">CALL</span>${esc(c.t)}`;
  b.onclick = () => grpcCall(c);
  $('#grpcBtns').appendChild(b);
});

function bars(rows) {
  const max = Math.max(...rows.map(r => r.v), 1);
  return rows.map(r =>
    `<div class="bar"><div>${r.label}</div>
      <div class="track"><div class="fill" style="width:${(r.v / max) * 100}%;background:${r.color}"></div></div>
      <div class="val">${r.text ?? r.v}</div></div>`).join('');
}

async function grpcCall(c) {
  const t0 = performance.now();
  const res = await fetch(c.u);
  const ms = Math.round(performance.now() - t0);
  const body = await res.json();
  $('#grpcBody').textContent = JSON.stringify(body, null, 2);

  if (body.wire) {
    const saved = Math.round((1 - body.wire.protobufBytes / body.wire.jsonBytes) * 100);
    $('#grpcMetrics').innerHTML =
      metric('protobuf bytes', body.wire.protobufBytes) +
      metric('same as json', body.wire.jsonBytes) +
      metric('smaller by', saved + '%') +
      metric('ms', ms);
    $('#grpcChart').innerHTML = bars([
      { label: 'protobuf', v: body.wire.protobufBytes, color: 'var(--grpc)', text: body.wire.protobufBytes + ' B' },
      { label: 'json equivalent', v: body.wire.jsonBytes, color: 'var(--faint)', text: body.wire.jsonBytes + ' B' }
    ]);
  } else {
    $('#grpcMetrics').innerHTML = metric('http status', res.status) + metric('ms', ms);
    $('#grpcChart').innerHTML = '';
  }
}

let stream = null;
$('#grpcWatch').onclick = () => {
  if (stream) { stream.close(); stream = null; }
  const box = $('#grpcStream');
  box.innerHTML = '<div class="ev">stream opened - one request, many responses</div>';
  stream = new EventSource('/grpc/watch?limit=10');
  stream.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    box.insertAdjacentHTML('afterbegin',
      `<div class="ev"><b>${esc(ev.title)}</b> - ${esc(ev.artist)} <span class="sub">· ${esc(ev.city)} · ${esc(ev.at.slice(11, 19))}</span></div>`);
  };
  stream.addEventListener('done', () => {
    box.insertAdjacentHTML('afterbegin', '<div class="ev">server closed the stream</div>');
    stream.close(); stream = null;
  });
  stream.addEventListener('error', () => {
    box.insertAdjacentHTML('afterbegin', '<div class="ev">stream error - is the gRPC server running?</div>');
    if (stream) { stream.close(); stream = null; }
  });
};

$('#grpcProto').onclick = async () => {
  const r = await fetch('/grpc/proto');
  $('#grpcBody').textContent = (await r.json()).proto;
};

/* ----------------------------------------------------------- comparison -- */
$('#cmpRun').onclick = async () => {
  $('#cmpCharts').innerHTML = '<p class="hint">measuring…</p>';
  const data = await (await fetch('/compare')).json();
  const colour = (l) => l.startsWith('REST') ? 'var(--rest)' : l.startsWith('GraphQL') ? 'var(--gql)' : 'var(--grpc)';

  const block = (title, note, rows) =>
    `<div class="chartblock"><h3>${title}</h3><p class="hint">${note}</p>${bars(rows)}</div>`;

  $('#cmpCharts').innerHTML =
    `<p class="hint">${esc(data.scenario)}</p>` +
    block('Round trips', 'Each one pays the full network latency. On a 4G phone that is ~100 ms per call, whatever your server does.',
      data.results.map(r => ({ label: r.label, v: r.calls, color: colour(r.label), text: r.calls + ' calls' }))) +
    block('Bytes over the wire', 'gRPC is measured as the actual protobuf frame; the rest are JSON payloads.',
      data.results.map(r => ({ label: r.label, v: r.bytes, color: colour(r.label), text: r.bytes + ' B' }))) +
    block('Server time (localhost, so network latency is ~0)', 'The honest caveat: on localhost round trips look free. They are not. Re-read the first chart.',
      data.results.map(r => ({ label: r.label, v: r.ms, color: colour(r.label), text: r.ms + ' ms' })));
};

/* -------------------------------------------------------------- process -- */
const STEPS = [
  { h: 'Find the jobs, not the tables', p: 'Write down what consumers are trying to accomplish, in their words. "Show an artist page", "let a partner sync yesterday’s plays". If your first draft mirrors your database schema, you have designed a database viewer, not an API.',
    out: 'Output: a list of use cases with the actor named for each.',
    items: ['List every consumer type (web, mobile, partner, internal)', 'Write 5-10 concrete jobs as sentences', 'Note the constraints each consumer has (offline? slow network? no proxy?)'] },
  { h: 'Model the domain', p: 'Name the nouns, their relationships and their identity. Get the vocabulary right before choosing a protocol - the words in your API outlive every implementation detail.',
    out: 'Output: an entity sketch with IDs, relationships and cardinality.',
    items: ['Name the entities using the language your business already speaks', 'Decide identity: opaque IDs, not database row numbers', 'Mark relationships and their cardinality'] },
  { h: 'Choose the style deliberately', p: 'REST, GraphQL, gRPC, events. Decide with the flow chart on the Compare tab and write down the reason. "It is what we know" is a valid reason - an unwritten one is not.',
    out: 'Output: one paragraph of rationale you can defend in review.',
    items: ['Identify the consumer and the network between you', 'Check the caching, streaming and typing needs', 'Record the decision and what would change it'] },
  { h: 'Design the contract', p: 'Endpoint or schema or .proto. Include the failure cases from the start - the error format is the part every client actually integrates against.',
    out: 'Output: an OpenAPI / SDL / .proto file, written before the handler.',
    items: ['Name resources or types; nouns, plural, lowercase', 'Define every payload shape, including errors', 'Pick pagination, filtering and sorting conventions once, apply everywhere', 'Decide auth: who calls this, with what credential, at what rate'] },
  { h: 'Prototype against the contract', p: 'Mock it and build a real client screen against the mock. You will find the missing field on day one instead of after launch, when it is a breaking change.',
    out: 'Output: a working client screen fed by a mock server.',
    items: ['Generate a mock from the spec', 'Have a real consumer build against it', 'Rewrite the contract from what they hit - this is the cheapest edit you will ever make'] },
  { h: 'Review it like a publication', p: 'Consistency, security, and change safety. Ask what happens on retry, on partial failure, on a client three versions old.',
    out: 'Output: a signed-off contract plus a written versioning policy.',
    items: ['Consistent naming, casing, dates (ISO 8601) and error shape', 'Every unsafe operation is idempotent or explains why not', 'Authorisation checked per resource, not just per route', 'Pagination on every collection - no unbounded lists', 'Versioning and deprecation policy written down with dates'] },
  { h: 'Ship with the operational parts attached', p: 'An API without docs, examples, limits and metrics is a liability. The contract is what you promised; observability is how you find out you broke it.',
    out: 'Output: docs with runnable examples, rate limits, dashboards, changelog.',
    items: ['Reference docs generated from the spec, plus a quickstart', 'Rate limits and quotas, documented and enforced', 'Metrics per endpoint: latency, error rate, usage by consumer', 'A changelog and a way to tell consumers before you break them'] }
];

const KEY = 'api-design-process';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* storage blocked - the page still works */ }
$('#steps').innerHTML = STEPS.map((s, i) => `
  <div class="step">
    <header><span class="n">STEP ${i + 1}</span><h4>${s.h}</h4></header>
    <p>${s.p}</p>
    <ul>${s.items.map((it, j) => {
      const id = i + '-' + j, on = saved[id] ? 'checked' : '';
      return `<li class="${on ? 'done' : ''}"><input type="checkbox" data-k="${id}" ${on}><span>${it}</span></li>`;
    }).join('')}</ul>
    <div class="out">${s.out}</div>
  </div>`).join('');

$$('#steps input').forEach(cb => cb.onchange = () => {
  saved[cb.dataset.k] = cb.checked;
  cb.closest('li').classList.toggle('done', cb.checked);
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ }
});

/* first paint */
$('.arch-svg .hot').dispatchEvent(new Event('click'));
