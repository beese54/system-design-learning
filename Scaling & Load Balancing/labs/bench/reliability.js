// Tabs 6 and 7 - Health and Failure.
//
// Health is the mechanism: what the checker sees, and how a fault becomes an
// ejection. Failure is the consequence: what a user experiences while that is
// happening, measured on an open loop so the queue is visible.
import { measure } from '../load/driver.js';
import { DEFAULTS } from '../lb/health.js';
import { STATES } from '../fleet/faults.js';
import { lab, sup, ensureFleet, workPath, lbUrl, preflight } from './state.js';

const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const faults = () =>
  Object.entries(STATES).map(([id, s]) => ({ id, label: s.label, teaches: s.teaches }));

export const checkConfig = () => ({ ...DEFAULTS, ...lab.lb.cfg });

/** Point the health checker at a different endpoint. This one switch is the
 *  entire cascading-outage lesson. */
export function checkPath(path) {
  const allowed = ['/healthz', '/readyz', '/deepz'];
  if (!allowed.includes(path)) return { ok: false, error: 'Path must be one of ' + allowed.join(', ') };
  lab.lb.checker.cfg.path = path;
  return {
    ok: true,
    path,
    note: path === '/deepz'
      ? 'The checker now asks every instance whether it can reach the database. That sounds more thorough. Break the database and watch what it does to a fleet in which nothing is actually wrong.'
      : path === '/healthz'
        ? 'Liveness only: is the process alive. It will not notice an instance that is up but useless - which is what the `error` and `zombie` faults are.'
        : 'Readiness: should this instance receive traffic. The right default for a load balancer.'
  };
}

export async function inject(id, state, opts = {}) {
  const out = await sup.inject(id, state, opts);
  return { ...out, teaches: STATES[state]?.teaches };
}

export async function revive(id) {
  return sup.revive(id, 1500);
}

/**
 * Time how long the balancer takes to notice a fault and stop using the
 * instance. Run per fault type, the numbers differ by an order of magnitude,
 * and that difference is the lesson.
 */
// Wait until the balancer positively considers this instance healthy.
//
// Without this, running two detection tests in a row measures nothing: the
// second one starts while the target is still ejected from the first, sees a
// non-healthy status immediately, and reports a detection time of about 2 ms.
// The first version of this tab did exactly that and produced four identical
// meaningless numbers. A timing test has to start from a known state.
async function waitHealthy(id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = lab.lb.snapshot().health.nodes.find((x) => x.id === id);
    if (node && node.status === 'healthy') return true;
    await sleep(100);
  }
  return false;
}

export async function detectionTime({ fault = 'dead', instances = 4 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(3, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);
  await sleep(1200);

  const target = sup.list()[0].id;
  const settled = await waitHealthy(target);
  if (!settled) {
    return {
      fault,
      target,
      ejectedMs: null,
      ok: false,
      error: `${target} was still not healthy after 20s, so a detection time measured from here would be meaningless. Let the fleet settle and try again.`
    };
  }

  const t0 = Date.now();
  await sup.inject(target, fault);

  let ejectedMs = null;
  while (Date.now() - t0 < 15000) {
    const node = lab.lb.snapshot().health.nodes.find((x) => x.id === target);
    if (node && (node.status === 'ejected' || node.status === 'probing')) { ejectedMs = Date.now() - t0; break; }
    await sleep(25);
  }

  const node = lab.lb.snapshot().health.nodes.find((x) => x.id === target);
  const lastError = node?.lastError;
  await sup.revive(target, 500);

  return {
    fault,
    target,
    ejectedMs,
    lastError,
    theoreticalMs: DEFAULTS.intervalMs * DEFAULTS.ejectAfter,
    teaches: STATES[fault]?.teaches,
    readMe: ejectedMs === null
      ? `After 15 seconds the balancer had still not ejected the "${fault}" instance. That is the finding, not a bug: this fault is invisible to a ${lab.lb.checker.cfg.path} probe, because the instance answers that probe perfectly well and only fails the work.\n\n` +
        `Note that no traffic was flowing during this test - only probes. Run the same fault under load in the Failure tab and it IS caught, because the balancer also watches what real requests do: three consecutive genuine failures eject a backend that every probe says is fine. That is passive health checking, and this pair of results is the argument for having both. Active probes find a backend that has stopped answering; only real traffic finds one that answers wrongly.`
      : `Detected and ejected in ${ejectedMs} ms (${DEFAULTS.ejectAfter} consecutive failures at a ${DEFAULTS.intervalMs} ms interval, so ${DEFAULTS.intervalMs * DEFAULTS.ejectAfter} ms is the floor). ` +
        `The probe reported "${lastError}". ` +
        (lastError === 'timeout'
          ? 'Note that this fault costs a full probe timeout every attempt, which is why it takes measurably longer to detect than a refused connection - and why a TCP-only health check would never detect it at all.'
          : lastError === 'ECONNREFUSED'
            ? 'A refused connection is the best kind of failure: instant and unambiguous. This is the floor for how fast detection can possibly be.'
            : 'The instance answered, but not acceptably.')
  };
}

/**
 * The cascade. Point every instance's readiness at the shared database, break
 * the database, and a fleet in which nothing is wrong ejects itself entirely.
 *
 * Then show the two things that stop it: readiness that depends only on local
 * state, and a panic threshold that refuses to eject past half the pool.
 */
export async function cascade({ instances = 4 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(3, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);

  const phases = [];

  // Deep checks, dependency broken on every instance at once.
  checkPath('/deepz');
  await sleep(1200);
  for (const i of sup.list()) await sup.inject(i.id, 'deep-fail');
  await sleep(3000);
  let snap = lab.lb.snapshot().health;
  phases.push({
    phase: 'deep check, dependency down',
    healthy: snap.healthy,
    total: snap.total,
    panic: snap.panic,
    note: `${snap.total - snap.healthy} of ${snap.total} instances ejected. Not one of them is broken - they can all still serve every request that does not touch the database.`
  });

  // Same fault, readiness that only reports on local state.
  //
  // The wait has to cover the whole return journey, not just one probe:
  // probeAfterMs before an ejected node is looked at again, then restoreAfter
  // consecutive passes at the probe interval. Sleeping for less than that shows
  // a fleet still ejected and makes it look as though changing the check did
  // not help - which is the opposite of the lesson.
  checkPath('/readyz');
  const recoveryMs = DEFAULTS.probeAfterMs + DEFAULTS.restoreAfter * DEFAULTS.intervalMs + 2000;
  await sleep(recoveryMs);
  snap = lab.lb.snapshot().health;
  phases.push({
    phase: 'readiness check, same dependency still down',
    healthy: snap.healthy,
    total: snap.total,
    panic: snap.panic,
    note: `${snap.healthy} of ${snap.total} instances back in rotation. Nothing about the dependency changed - only what the health check was asked.`
  });

  for (const i of sup.list()) await sup.revive(i.id, 300);
  await sleep(1500);

  return {
    instances: n,
    phases,
    readMe:
      `A deep health check feels more responsible than a shallow one. It is the opposite.\n\n` +
      `When readiness depends on a shared dependency, every instance fails its check at the same instant, and a balancer that believes them removes the entire fleet. A degraded service - some requests failing - becomes a total outage, and the outage is caused by the health check rather than by the fault.\n\n` +
      `Two things prevent it. Readiness should report on what THIS instance can do with what it has locally; a dependency being down is not a reason to take a working process out of rotation, it is a reason to serve degraded responses. And the balancer needs a panic threshold: when more than half the pool fails at once, the cause is almost certainly shared, and sending traffic to possibly-working backends beats sending it nowhere.\n\n` +
      `Deep checks are still useful. They belong in your monitoring, where a human reads them, not in the loop that decides where to send the next request.`
  };
}

/**
 * Failure, as the user experiences it. Sustained open-loop traffic while an
 * instance dies and comes back, sampled over time so the recovery curve is
 * visible rather than averaged away.
 */
export async function outage({
  instances = 4,
  fault = 'dead',
  ratePerSec = 120,
  retry = true,
  windowMs = 2000,
  windows = 6
} = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(3, Math.min(instances, lab.budget.fleet));
  await ensureFleet(n, 1);
  lab.lb.setRetry(retry);
  await sleep(1000);
  lab.lb.resetStats();

  const url = lbUrl(workPath({ mode: 'cpu', downstreamMs: 0 }));
  const timeline = [];
  const target = sup.list()[1].id;
  let injectedAt = null;
  let revivedAt = null;

  for (let w = 0; w < windows; w++) {
    // Break it after the first window, fix it after the third.
    if (w === 1) { await sup.inject(target, fault); injectedAt = w; }
    if (w === 3) { await sup.revive(target, 800); revivedAt = w; }

    const r = await measure({
      url, mode: 'open', ratePerSec, durationMs: windowMs, warmupMs: 0
    });
    const h = lab.lb.snapshot().health;
    timeline.push({
      window: w,
      atSec: round2((w * windowMs) / 1000),
      rps: r.rps,
      errorRatePct: r.errorRatePct,
      p50: r.waited?.p50 ?? r.service.p50,
      p99: r.waited?.p99 ?? r.service.p99,
      healthy: h.healthy,
      total: h.total,
      event: w === injectedAt ? `${target} -> ${fault}` : (w === revivedAt ? `${target} revived` : '')
    });
  }

  const worst = timeline.reduce((a, b) => (b.errorRatePct > a.errorRatePct ? b : a), timeline[0]);
  const totalErrors = round2(timeline.reduce((a, b) => a + b.errorRatePct, 0) / timeline.length);

  return {
    instances: n,
    fault,
    ratePerSec,
    retry,
    target,
    timeline,
    worstWindow: worst,
    meanErrorPct: totalErrors,
    readMe:
      `Constant arrival rate throughout, so this is what a user would have seen rather than what a patient benchmark would have reported.\n\n` +
      (retry
        ? `Retry was ON, and the worst window still only lost ${worst.errorRatePct}% of requests. That is the point of it: when one backend of ${n} fails, the balancer quietly sends the request to another one and nobody outside ever learns that anything happened. Run this again with retry off to see what it was hiding.\n\n` +
          `Retry is not free. Every retried request is work done twice, so a fleet that is already near capacity can retry itself into a much worse outage than the one it was papering over. And it is only safe at all because this endpoint is idempotent - retrying a payment is a different lesson and a worse afternoon.\n\n`
        : `Retry was OFF, so this is the raw damage. The worst window lost ${worst.errorRatePct}% of requests with p99 at ${worst.p99} ms - roughly the share of traffic that was still being sent to a broken instance. Turn retry on and the same outage becomes nearly invisible.\n\n`) +
      `Errors do not begin the instant the instance breaks and they do not stop the instant it is ejected. The window in between is your error budget, and its size is set by the detection parameters - probe interval times failure threshold - not by the fault.\n\n` +
      `Recovery is the half people forget. The instance comes back not-ready, ramps in over ten seconds, and only then carries a full share. Skip that ramp and a cold process takes a full load immediately, fails again, and you have built an oscillator.`
  };
}
