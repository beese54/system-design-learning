// Tab 5 - Stateless.
//
// Three ways to keep a user's session across a fleet, each measured rather than
// argued about. This tab exists because the statelessness lesson is the one
// most often asserted and least often priced.
import { q } from '../db/pool.js';
import { hash32, reshuffleFraction } from '../lb/policies.js';
import { measure } from '../load/driver.js';
import { lab, sup, ensureFleet, workPath, lbUrl, preflight } from './state.js';

const round2 = (n) => Math.round(n * 100) / 100;

const keys = (n) => Array.from({ length: n }, (_, i) => 'session-' + i);

/**
 * If sessions live in each process's memory and the balancer spreads requests
 * evenly, what fraction of requests arrive at an instance that has never seen
 * this user before?
 *
 * The answer is (n-1)/n and it is devastating, but it is worth measuring rather
 * than deriving, because seeing 75% of carts land on the wrong machine is more
 * persuasive than the fraction that predicts it.
 */
export async function inMemory({ instances = 4, users = 2000 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(2, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);
  const ids = sup.list().map((i) => i.id);

  // Simulate the routing rather than the storage: which instance would each
  // request land on, and is it the one holding this user's session?
  //
  // The requests have to be INTERLEAVED to mean anything. A first version walked
  // one user at a time, taking two consecutive slots from the round-robin
  // cursor - so the follow-up always landed on the very next instance and the
  // answer came out at a suspiciously round 100%. Real users do not take turns;
  // their requests are shuffled together with everybody else's, which is what
  // makes the instance a follow-up lands on effectively arbitrary.
  const stream = [];
  for (const k of keys(users)) { stream.push(k); stream.push(k); }
  // Deterministic shuffle, so the number is reproducible between runs.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = stream.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [stream[i], stream[j]] = [stream[j], stream[i]];
  }

  let wrong = 0;
  let followUps = 0;
  const home = new Map();
  let cursor = 0;
  for (const k of stream) {
    const landedOn = ids[cursor++ % ids.length];
    if (!home.has(k)) { home.set(k, landedOn); continue; }  // first visit creates the session
    followUps++;
    if (landedOn !== home.get(k)) wrong++;
  }

  const pct = round2((wrong / Math.max(followUps, 1)) * 100);
  return {
    instances: n,
    users,
    wrongInstancePct: pct,
    theoretical: round2(((n - 1) / n) * 100),
    readMe:
      `With sessions in process memory and round-robin routing, ${pct}% of follow-up requests reach an instance that has never heard of that user - the theoretical figure is ${round2(((n - 1) / n) * 100)}%. ` +
      `Every one of those is a logged-out user or an empty basket. ` +
      `Note what this means as you scale: the MORE instances you add, the worse it gets. In-process state does not merely fail to scale, it actively punishes scaling.`
  };
}

/**
 * Stickiness fixes correctness and introduces two new problems: uneven load,
 * and a reshuffle when the pool changes. Both are measured here.
 */
export async function sticky({ instances = 4, users = 20000 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(2, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);
  const ids = sup.list().map((i) => i.id);
  const ks = keys(users);

  // Load spread under modulo hashing.
  const counts = new Map(ids.map((id) => [id, 0]));
  for (const k of ks) {
    const id = ids[hash32(k) % ids.length];
    counts.set(id, counts.get(id) + 1);
  }
  const pcts = [...counts.values()].map((c) => round2((c / users) * 100));
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const skew = round2(((Math.max(...pcts) - Math.min(...pcts)) / mean) * 100);

  // What happens when one instance goes away?
  const after = ids.slice(0, -1);
  const modulo = reshuffleFraction(ids, after, ks, { consistent: false });
  const ring = reshuffleFraction(ids, after, ks, { consistent: true });

  return {
    instances: n,
    users,
    distribution: [...counts.entries()].map(([id, c]) => ({ id, n: c, pct: round2((c / users) * 100) })),
    skewPct: skew,
    reshuffle: { moduloPct: modulo, consistentPct: ring, idealPct: round2(100 / n) },
    readMe:
      `Stickiness makes the wrong-instance rate zero, which is the whole point of it. It costs two things.\n\n` +
      `Balance: keys hash unevenly, so the busiest instance carries ${skew}% more than the quietest. Affinity is not balance, and no amount of load-aware policy can fix it while the key must go where it must go.\n\n` +
      `Change: lose one instance of ${n} and modulo hashing moves ${modulo}% of your users to a machine that has never seen them - very nearly all of them. A consistent hash ring moves ${ring}%, against an ideal of ${round2(100 / n)}%. ` +
      `That difference is why consistent hashing exists, and it is the whole of it: not better balance, just far less disruption when the pool changes.`
  };
}

/**
 * Move the session to the shared database and both problems vanish. Measure
 * what it costs per request, because "just use a shared store" is advice with
 * a price tag that nobody quotes.
 */
export async function shared({ instances = 4, durationMs = 3000 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(2, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);

  // Baseline: work with no session handling at all.
  const withoutSession = await measure({
    url: lbUrl(workPath({ mode: 'io:query', downstreamMs: 0 })),
    concurrency: n * 4,
    durationMs,
    warmupMs: 800
  });

  // Measure the session round trip directly - a read and a write, which is what
  // a session-backed request actually adds.
  const sid = 'bench-' + Date.now();
  await q('INSERT INTO sessions (id, served_by, hits) VALUES ($1, $2, 0) ON CONFLICT (id) DO NOTHING', [sid, 'bench']);

  const samples = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    await q('SELECT id, hits FROM sessions WHERE id = $1', [sid]);
    await q('UPDATE sessions SET hits = hits + 1, last_seen = now(), served_by = $2 WHERE id = $1', [sid, 'bench']);
    samples.push(performance.now() - t0);
  }
  await q('DELETE FROM sessions WHERE id = $1', [sid]);

  samples.sort((a, b) => a - b);
  const p50 = round2(samples[Math.floor(samples.length / 2)]);
  const p99 = round2(samples[Math.floor(samples.length * 0.99)]);

  return {
    instances: n,
    baselineRps: withoutSession.rps,
    baselineP50: withoutSession.service.p50,
    sessionRoundTripP50: p50,
    sessionRoundTripP99: p99,
    overheadPct: withoutSession.service.p50 ? round2((p50 / withoutSession.service.p50) * 100) : null,
    readMe:
      `A shared session store makes the wrong-instance rate zero and lets any instance serve any user, which is what makes a fleet genuinely interchangeable - and interchangeable is what lets you deploy, autoscale and lose a machine without anybody noticing.\n\n` +
      `It costs ${p50} ms per request at p50 and ${p99} ms at p99 - one read and one write against the shared database. ` +
      `That is the statelessness tax, and it is the right trade almost every time, but it is a real number and it lands on every single request.\n\n` +
      `It also moves the problem rather than deleting it: the database is now on the critical path for every request in the fleet, which is what Lesson 09 is about. This is the point where a cache stops being an optimisation and becomes architecture - and that is Chapter IV.`
  };
}
