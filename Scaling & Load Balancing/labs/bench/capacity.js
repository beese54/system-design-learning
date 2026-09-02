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

  // The knee: the lowest concurrency at which throughput has already reached its
  // plateau. Past it you are buying latency and nothing else.
  //
  // Finding it needs care, and the naive version was wrong. Taking the single
  // highest rps as "peak" and then looking for the first point within 95% of it
  // makes the noisiest sample define the answer: on a flat curve the maximum is
  // just whichever run got lucky, so the knee came out at the LAST concurrency
  // tested rather than the first. It reported c=64 for a curve that plateaued
  // around c=2.
  //
  // So the plateau is the median of the best three points, which one lucky run
  // cannot move, and the knee is the first concurrency to reach it.
  const observedPeak = Math.max(...points.map((p) => p.rps));
  const sortedRps = points.map((p) => p.rps).sort((a, b) => b - a);
  const plateau = sortedRps.slice(0, 3).sort((a, b) => a - b)[Math.min(1, sortedRps.length - 1)];

  let knee = points[0];
  for (const p of points) {
    if (p.rps >= plateau * 0.95) { knee = p; break; }
  }

  const worst = points[points.length - 1];
  // "Flat" means throughput never climbed from the very first point - which is
  // its own lesson and should not be dressed up as a curve with a knee in it.
  //
  // Measured against the FIRST point, not the lowest. A single noisy dip in the
  // middle of the sweep would otherwise make a perfectly flat line look like it
  // had doubled.
  const flat = plateau / Math.max(points[0].rps, 0.01) < 1.6;

  return {
    mode,
    cores: lab.budget.cores,
    workUnitMs: lab.cpu.measuredMs,
    points,
    knee: { concurrency: knee.concurrency, rps: knee.rps, p99: knee.p99 },
    peakRps: round2(observedPeak),
    plateauRps: round2(plateau),
    flat,
    readMe:
      `One instance, one worker, ${mode} work. Throughput plateaus around ${Math.round(plateau)} rps, and it gets there at concurrency ${knee.concurrency}, where p99 is ${knee.p99} ms. ` +
      `Pushing on to concurrency ${worst.concurrency} leaves throughput at ${worst.rps} rps - essentially unchanged - while p99 goes to ${worst.p99} ms.\n\n` +
      (flat
        ? `Notice that the throughput line is almost flat from the very first point. That is exactly right for single-threaded ${mode} work: one worker can burn one core, and one core does ${round2(lab.cpu.measuredMs)} ms of work at a time no matter how many people are waiting. The queue is the only thing that grows. There is no knee here because there was never a climb - the capacity was reached at concurrency 1 or 2 and everything after that is just people standing in line.\n\n`
        : '') +
      `That is the whole of capacity planning in two numbers: past the plateau, extra concurrency buys latency and nothing else. ` +
      `Little's Law says why - throughput equals concurrency divided by latency, so once throughput is fixed, adding concurrency can only raise latency. ` +
      `The p99 line on the chart is on its own scale; both series share an x-axis but nothing else.`
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
