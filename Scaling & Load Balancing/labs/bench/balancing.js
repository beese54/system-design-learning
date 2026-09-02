// Tab 4 - Balancer.
//
// Absorbs what would have been a separate "compare" tab, because a tab with no
// controls of its own is a chart rather than a lab.
import { measure } from '../load/driver.js';
import { describe as describePolicies } from '../lb/policies.js';
import { lab, sup, ensureFleet, workPath, lbUrl, preflight } from './state.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const policies = () => describePolicies();

// Spread of the per-instance request counts, as a percentage. Zero means
// perfectly even. This is the number that shows affinity is not balance.
function skewPct(distribution) {
  if (!distribution.length) return 0;
  const pcts = distribution.map((d) => d.pct);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  if (!mean) return 0;
  return round2(((Math.max(...pcts) - Math.min(...pcts)) / mean) * 100);
}

/**
 * Run every policy against the same fleet and the same load.
 *
 * On a healthy homogeneous fleet all of them look identical, and a reader who
 * stops there concludes the choice does not matter. It matters enormously the
 * moment one backend is not like the others - which is what `degrade` is for,
 * and why it defaults to on.
 */
export async function compare({
  mode = 'cpu',
  instances = 4,
  durationMs = 3000,
  degrade = 'slow',
  degradeTarget = 'i3'
} = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(2, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);

  const target = sup.list().some((i) => i.id === degradeTarget) ? degradeTarget : sup.list()[0].id;
  if (degrade && degrade !== 'none') await sup.inject(target, degrade);

  const results = [];
  for (const p of ['round-robin', 'least-conn', 'p2c']) {
    lab.lb.setPolicy(p);
    lab.lb.resetStats();
    const r = await measure({
      url: lbUrl(workPath({ mode, downstreamMs: 0 })),
      concurrency: n * 4,
      durationMs,
      warmupMs: 900
    });
    const stats = lab.lb.snapshot().stats;
    results.push({
      label: p,
      ms: r.service.p50,
      rps: r.rps,
      p50: r.service.p50,
      p95: r.service.p95,
      p99: r.service.p99,
      errorRatePct: r.errorRatePct,
      retried: stats.retried,
      skewPct: skewPct(r.distribution),
      distribution: r.distribution,
      toDegraded: r.distribution.find((d) => d.id === target)?.pct ?? 0,
      note: ''
    });
  }

  if (degrade && degrade !== 'none') await sup.revive(target, 300);
  lab.lb.setPolicy('round-robin');

  const rr = results.find((r) => r.label === 'round-robin');
  const lc = results.find((r) => r.label === 'least-conn');
  const gain = rr.rps ? round2(lc.rps / rr.rps) : null;

  for (const r of results) {
    r.note = degrade && degrade !== 'none'
      ? `sent ${r.toDegraded}% to the ${degrade} instance`
      : `spread ${r.skewPct}% between busiest and quietest`;
  }

  return {
    scenario: degrade && degrade !== 'none'
      ? `${n} instances, one of them injected as "${degrade}"`
      : `${n} healthy instances`,
    mode,
    degraded: degrade !== 'none' ? target : null,
    results,
    readMe: degrade && degrade !== 'none'
      ? `Round robin has no idea anything is wrong. It keeps sending the ${degrade} instance its full share - ${rr.toDegraded}% - and the whole service runs at ${rr.rps} rps. ` +
        `Least connections notices within a few requests, because a struggling backend accumulates in-flight work and stops being picked; it drops to ${lc.toDegraded}% and the service holds ${lc.rps} rps. ` +
        `That is ${gain}x the throughput from one line of policy, on identical hardware.\n\n` +
        `Power of two choices gets nearly the same result while only ever looking at two backends, which is what keeps it cheap when the pool is large.\n\n` +
        `The catch is in the next tab: all three of these choose on in-flight count, and an instance that fails INSTANTLY has no in-flight requests at all.`
      : `Every policy looks the same here, and that is the honest result: on a healthy fleet of identical instances there is nothing to choose between them. ` +
        `Spread between the busiest and quietest instance is ${rr.skewPct}% for round robin and ${lc.skewPct}% for least connections. ` +
        `Inject a fault and run this again - the differences only exist when the backends stop being interchangeable.`
  };
}

/**
 * The zombie. A backend that fails instantly looks, to any policy that chooses
 * on in-flight count or latency, like the fastest and least loaded member of
 * the pool - so the smarter the policy, the more traffic it funnels into the
 * black hole.
 *
 * Health checking normally rescues this within a couple of seconds, so the
 * demonstration turns ejection off to show what the POLICY does on its own.
 */
export async function zombie({ instances = 4, durationMs = 3000 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(3, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);

  // Stop the ACTIVE probe and suspend ejection, so the policy has to cope
  // unaided. Stopping the probe alone is not enough: passive health still
  // watches real request outcomes, and three failed requests eject the zombie
  // in well under a second - which is excellent behaviour and completely hides
  // the thing this demonstration exists to show. Retries are off too, so the
  // damage is visible rather than papered over.
  lab.lb.checker.stop();
  lab.lb.checker.setEjection(false);
  lab.lb.setRetry(false);
  const target = sup.list()[1].id;
  await sup.inject(target, 'zombie');

  const results = [];
  for (const p of ['round-robin', 'least-conn', 'p2c']) {
    lab.lb.setPolicy(p);
    lab.lb.resetStats();
    const r = await measure({
      url: lbUrl(workPath({ mode: 'cpu', downstreamMs: 0 })),
      concurrency: n * 4,
      durationMs,
      warmupMs: 700
    });
    results.push({
      label: p,
      ms: r.service.p50,
      rps: r.rps,
      errorRatePct: r.errorRatePct,
      toZombie: r.distribution.find((d) => d.id === target)?.pct ?? 0,
      distribution: r.distribution,
      note: `${r.distribution.find((d) => d.id === target)?.pct ?? 0}% of traffic went into the black hole`
    });
  }

  await sup.revive(target, 300);
  lab.lb.checker.setEjection(true);
  lab.lb.setRetry(true);
  lab.lb.checker.start();
  lab.lb.setPolicy('round-robin');

  const fair = round2(100 / n);
  const rr = results.find((r) => r.label === 'round-robin');
  const lc = results.find((r) => r.label === 'least-conn');

  return {
    scenario: `${n} instances, ${target} failing instantly with a 500, health checking disabled`,
    fairSharePct: fair,
    results,
    readMe:
      `An even split would send ${fair}% to each instance. Round robin, which knows nothing, sends the zombie ${rr.toZombie}% - its fair share, no worse. ` +
      `Least connections sends it ${lc.toZombie}%, because failing instantly is indistinguishable from being idle: the zombie always has the fewest in-flight requests, so it always wins the comparison.\n\n` +
      `This is the one case where the naive policy beats the clever one. The fix is not to abandon least connections - it is to make success rate part of the decision, and to let the health checker eject on real request outcomes rather than probes alone. ` +
      `Turn checking back on (the Health tab) and the zombie is gone in about a second and a half.`
  };
}
