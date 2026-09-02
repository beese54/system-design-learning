// How the balancer chooses. Five policies, each with what it buys and what it
// costs, because a policy list without the costs is a menu rather than a
// decision.
//
// Every one of these is a few lines. That is the point: the interesting part of
// load balancing is not the arithmetic of choosing, it is knowing which
// property you are buying and which failure it exposes you to.
import { createHash } from 'node:crypto';

// A stable 32-bit hash. Not cryptographic - it just has to spread evenly and
// give the same answer on every process, which Math.random and object identity
// do not.
export function hash32(key) {
  return createHash('sha1').update(String(key)).digest().readUInt32BE(0);
}

// ------------------------------------------------------------ consistent ring
//
// Modulo hashing (`hash % n`) is the obvious way to make a key sticky, and it
// has one catastrophic property: change n and almost every key moves. Lose one
// instance out of four and roughly three quarters of your sessions land
// somewhere new.
//
// A consistent hash ring places each instance at many points around a circle
// and sends a key to the first instance clockwise of it. Remove an instance and
// only the keys that were sitting in its arcs move - about 1/n of them. The
// other keys cannot tell anything happened.
//
// Tab 5 measures both, so the difference is a number rather than a claim.
export function buildRing(ids, virtualNodes = 150) {
  const ring = [];
  for (const id of ids) {
    for (let v = 0; v < virtualNodes; v++) ring.push({ point: hash32(id + '#' + v), id });
  }
  ring.sort((a, b) => a.point - b.point);
  return ring;
}

export function ringPick(ring, key) {
  if (!ring.length) return null;
  const h = hash32(key);
  // Binary search for the first point clockwise of the key.
  let lo = 0, hi = ring.length - 1;
  if (h > ring[hi].point) return ring[0].id;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].point < h) lo = mid + 1; else hi = mid;
  }
  return ring[lo].id;
}

// -------------------------------------------------------------------- policies
//
// Each pick() receives the list of currently eligible backends and returns one.
// A backend looks like { id, inflight, ewmaMs, ... } - the balancer's own view,
// which is all a real balancer has to go on.

let rrCursor = 0;

export const POLICIES = {
  'round-robin': {
    label: 'Round robin',
    buys: 'Perfectly even REQUEST counts, and it costs nothing to compute.',
    costs: 'Even request counts are not even LOAD. One slow backend keeps receiving its full share and becomes the tail latency of the whole service.',
    pick: (pool) => pool[rrCursor++ % pool.length]
  },

  'least-conn': {
    label: 'Least connections',
    buys: 'Routes around slowness automatically: a backend that is struggling accumulates in-flight requests and stops being chosen.',
    costs: 'A backend that fails INSTANTLY has no in-flight requests at all, so this policy sends it more traffic, not less. That is the zombie case in Tab 7, and it is why success rate has to be part of the decision.',
    pick: (pool) => pool.reduce((best, b) => (b.inflight < best.inflight ? b : best), pool[0])
  },

  'p2c': {
    label: 'Power of two choices',
    buys: 'Nearly all the benefit of least-connections while only ever inspecting two backends, so it stays cheap with a large pool and does not stampede the way a global minimum does.',
    costs: 'Still blind to the zombie: it compares two backends on in-flight count, and instant failure still looks like idleness.',
    pick: (pool) => {
      if (pool.length < 2) return pool[0];
      const i = Math.floor(Math.random() * pool.length);
      // The second choice must be drawn INDEPENDENTLY. Deriving it from the
      // first (i+1, say) is the classic implementation bug: it turns a random
      // sample into a fixed pairing and quietly destroys the property that
      // makes the algorithm work.
      let j = Math.floor(Math.random() * pool.length);
      if (j === i) j = (j + 1) % pool.length;
      return pool[i].inflight <= pool[j].inflight ? pool[i] : pool[j];
    }
  },

  'hash': {
    label: 'Sticky (modulo hash)',
    buys: 'The same key always lands on the same backend, so in-process session state appears to work.',
    costs: 'Affinity is not balance - popular keys make hot backends. And changing the pool size moves almost every key at once, which Tab 5 measures.',
    sticky: true,
    pick: (pool, key) => pool[hash32(key ?? '') % pool.length]
  },

  'consistent-hash': {
    label: 'Sticky (consistent ring)',
    buys: 'Same stickiness, but losing a backend moves only about 1/n of the keys instead of nearly all of them.',
    costs: 'Still affinity rather than balance, and it needs virtual nodes to spread evenly - a naive ring with one point per backend is badly lopsided.',
    sticky: true,
    pick: (pool, key, ring) => {
      const id = ringPick(ring, key ?? '');
      return pool.find((b) => b.id === id) || pool[0];
    }
  }
};

export const policyNames = () => Object.keys(POLICIES);

export const describe = () =>
  Object.entries(POLICIES).map(([id, p]) => ({
    id, label: p.label, buys: p.buys, costs: p.costs, sticky: !!p.sticky
  }));

export function resetCursor() { rrCursor = 0; }

// How many keys change owner when the pool changes? This is the whole argument
// for consistent hashing, reduced to one measurable number.
export function reshuffleFraction(beforeIds, afterIds, keys, { consistent }) {
  const ringBefore = consistent ? buildRing(beforeIds) : null;
  const ringAfter = consistent ? buildRing(afterIds) : null;

  let moved = 0;
  for (const k of keys) {
    const a = consistent ? ringPick(ringBefore, k) : beforeIds[hash32(k) % beforeIds.length];
    const b = consistent ? ringPick(ringAfter, k) : afterIds[hash32(k) % afterIds.length];
    if (a !== b) moved++;
  }
  return Math.round((moved / keys.length) * 1000) / 10;
}
