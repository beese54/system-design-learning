// Tab 1 - Capacity.
//
// Nothing else in this lab is trustworthy until this tab has run. It measures
// the machine, the work unit, the platform's timer, and the load generator's
// own ceiling, and only then measures a server.
import { measure, compareLoops, instrumentLimited } from '../load/driver.js';
import { interleave } from '../load/calibrate.js';
import { acrossRuns } from '../load/histogram.js';
import { lab, sup, ensureFleet, workPath, preflight, snapshot } from './state.js';

const round2 = (n) => Math.round(n * 100) / 100;

export { preflight, snapshot };

// Concurrency ramp against a single instance. This is the shape every capacity
// conversation is really about: throughput climbs, flattens, and then latency
// takes off while throughput does not.
export async function ramp({ mode = 'cpu', durationMs = 3000 } = {}) {
  if (!lab.cpu) await preflight();
  await ensureFleet(1, 1);
  const inst = sup.list()[0];
  const url = 'http://127.0.0.1:' + inst.port + workPath({ mode, downstreamMs: 0 });

  const levels = mode === 'cpu'
    ? [1, 2, 4, 8, 16, 32, 64]
    : [1, 2, 4, 8, 16, 32, 64, 128, 256];

  const points = [];
  // Interleaved, never ascending: a laptop throttles under sustained load, and
  // an ascending sweep turns the cooling curve into a monotonic decline that
  // reads exactly like saturation.
  for (const c of interleave(levels)) {
    const r = await measure({ url, concurrency: c, durationMs, warmupMs: 800 });
    points.push({
      concurrency: c,
      rps: r.rps,
      p50: r.service.p50,
      p95: r.service.p95,
      p99: r.service.p99,
      errors: r.errors,
      instrument: instrumentLimited(r, lab.ceiling)
    });
  }
  points.sort((a, b) => a.concurrency - b.concurrency);

  // The knee: the last level where throughput was still meaningfully climbing.
  // Past it you are buying latency and nothing else.
  const peak = Math.max(...points.map((p) => p.rps));
  let knee = points[0];
  for (const p of points) {
    if (p.rps >= peak * 0.95) { knee = p; break; }
  }

  const worst = points[points.length - 1];

  return {
    mode,
    cores: lab.budget.cores,
    workUnitMs: lab.cpu.measuredMs,
    points,
    knee: { concurrency: knee.concurrency, rps: knee.rps, p99: knee.p99 },
    peakRps: round2(peak),
    readMe:
      `One instance, one worker, ${mode} work. Throughput peaks near ${Math.round(peak)} rps at concurrency ${knee.concurrency}, ` +
      `where p99 is ${knee.p99} ms. Pushing to concurrency ${worst.concurrency} moves throughput to ${worst.rps} rps - ` +
      `essentially nowhere - while p99 goes to ${worst.p99} ms. ` +
      `That is the whole of capacity planning in two numbers: past the knee, extra concurrency buys latency and nothing else. ` +
      `Little's Law says why - throughput equals concurrency divided by latency, so once throughput is fixed, adding concurrency can only raise latency.`
  };
}

// Closed loop versus open loop at the same offered load. The single most
// useful thing to know about load testing, and almost never demonstrated.
export async function omission({ mode = 'cpu', durationMs = 4000 } = {}) {
  if (!lab.cpu) await preflight();
  await ensureFleet(1, 1);
  const inst = sup.list()[0];
  const url = 'http://127.0.0.1:' + inst.port + workPath({ mode, downstreamMs: 0 });

  // Find capacity first, then offer noticeably more than that - the two loops
  // only diverge once the server is behind.
  const cap = await measure({ url, concurrency: 4, durationMs: 2500, warmupMs: 800 });
  const offered = Math.max(10, Math.round(cap.rps * 3));

  const cmp = await compareLoops({ url, concurrency: 8, ratePerSec: offered, durationMs });
  return { ...cmp, capacityRps: cap.rps };
}

// Repeat the same measurement and report how much it disagreed with itself.
// A reader who has seen this once will treat every other number in the chapter
// with the right amount of suspicion.
export async function noise({ mode = 'cpu', repeats = 4, durationMs = 2500 } = {}) {
  if (!lab.cpu) await preflight();
  await ensureFleet(1, 1);
  const inst = sup.list()[0];
  const url = 'http://127.0.0.1:' + inst.port + workPath({ mode, downstreamMs: 0 });

  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const r = await measure({ url, concurrency: 4, durationMs, warmupMs: 700 });
    runs.push({ run: i + 1, rps: r.rps, p50: r.service.p50, p99: r.service.p99, cv: r.service.cv });
  }

  const rps = acrossRuns(runs.map((r) => r.rps));
  const p99 = acrossRuns(runs.map((r) => r.p99));

  return {
    runs,
    rpsSpreadPct: rps.spreadPct,
    p99SpreadPct: p99.spreadPct,
    trustworthy: rps.trustworthy,
    readMe: rps.trustworthy
      ? `Four identical runs varied by ${rps.spreadPct}% in throughput and ${p99.spreadPct}% at p99. That is the noise floor on this machine right now: a difference smaller than that is not a result, and every comparison in this lab is checked against it before it is reported.`
      : `Four identical runs varied by ${rps.spreadPct}% in throughput and ${p99.spreadPct}% at p99, which is too much to draw fine conclusions from. Something else on this machine is competing for cores. Close it and run again, or only trust differences larger than ${rps.spreadPct}%.`
  };
}
