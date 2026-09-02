// Small HTTP helpers shared by the labs. Nothing framework-y on purpose:
// you should be able to see every byte the server decides to send.
import { createHash } from 'node:crypto';
import { counters, resetReads } from './catalog.js';

export function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const bytes = Buffer.byteLength(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes,
    // Lab-only instrumentation. The UI charts these; real APIs would not
    // expose them, but seeing cost per call is the whole lesson.
    'X-Lab-Reads': String(counters.reads),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    ...headers
  });
  res.end(payload);
  return bytes;
}

// RFC 9457 "Problem Details" - the standard shape for an HTTP API error.
// One error format across every endpoint beats a bespoke error per route.
export function problem(res, status, title, detail, extra = {}) {
  const body = { type: `https://riff.example/errors/${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, detail, ...extra };
  return send(res, status, body, { 'Content-Type': 'application/problem+json; charset=utf-8' });
}

export const etagOf = (obj) =>
  '"' + createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16) + '"';

export function startCall() { resetReads(); return process.hrtime.bigint(); }
export function msSince(t0) { return Number(process.hrtime.bigint() - t0) / 1e6; }

// Sparse fieldsets: ?fields=id,title lets a client ask for less.
export function pick(obj, fields) {
  if (!fields) return obj;
  const want = fields.split(',').map(s => s.trim()).filter(Boolean);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => want.includes(k)));
}
