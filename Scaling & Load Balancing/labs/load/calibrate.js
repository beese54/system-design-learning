// Three measurements the lab takes on itself, before it measures anything else.
//
// A benchmark that has not calibrated its own instruments is a rumour. Each
// function here exists because an uncalibrated version of it produced a wrong
// number during this chapter's build.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const round2 = (n) => Math.round(n * 100) / 100;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ---------------------------------------------------------------- CPU budget
//
// The unit of work has to be expressed in MILLISECONDS, not in hashing rounds.
// A fixed round count means a fast machine does less work per request and a
// slow one does more, so the same "experiment" is a different experiment on
// every reader's laptop and none of the curves are comparable.
//
// Calibrated once, on the lab host, and the resulting round count is handed to
// every instance so the whole fleet does byte-identical work. Deliberately NOT
// re-calibrated per instance: if each instance tuned itself to the core it
// happened to land on, the slower cores would quietly do less work and the
// hardware heterogeneity this chapter wants to expose would disappear into the
// calibration.
export function burn(rounds, seed = 'calibrate') {
  let buf = Buffer.from(seed);
  for (let i = 0; i < rounds; i++) buf = createHash('sha256').update(buf).digest();
  return buf.toString('hex').slice(0, 8);
}

export function calibrateCpu(targetMs = 15) {
  // Warm up first: V8 tiers this loop up substantially, and calibrating against
  // the interpreter would set a round count that is far too low once the JIT
  // has caught up.
  for (let i = 0; i < 5; i++) burn(2000);

  let rounds = 2000;
  let ms = 0;

  // Scale up until we pass the target, then interpolate. Doubling first avoids
  // a long linear crawl on a fast machine.
  for (let step = 0; step < 20; step++) {
    const t0 = performance.now();
    burn(rounds);
    ms = performance.now() - t0;
    if (ms >= targetMs) break;
    rounds = Math.max(rounds + 500, Math.ceil(rounds * Math.max(1.4, targetMs / Math.max(ms, 0.1))));
  }

  const scaled = Math.max(500, Math.round(rounds * (targetMs / ms)));

  // Verify the scaled value rather than trusting the arithmetic. Nine samples
  // rather than a handful: on a busy scheduler a single burn can be descheduled
  // mid-loop, and one such sample would drag a mean badly. The median of nine
  // is robust to a couple of those.
  const checks = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    burn(scaled);
    checks.push(performance.now() - t0);
  }

  const measured = median(checks);
  const spread = Math.max(...checks) - Math.min(...checks);
  const spreadPct = (spread / measured) * 100;

  return {
    rounds: scaled,
    targetMs,
    measuredMs: round2(measured),
    spreadMs: round2(spread),
    spreadPct: round2(spreadPct),
    // A wide spread here is not a calibration failure - it is the machine
    // telling you it is busy. Worth surfacing, because every latency number
    // taken afterwards inherits that same jitter.
    noisy: spreadPct > 30,
    note: spreadPct > 30
      ? `1 CPU work unit = ${scaled} SHA-256 rounds ~= ${round2(measured)} ms, but repeats of that same work varied by ${round2(spreadPct)}%. Something else on this machine is competing for cores; close it, or treat small differences in the results below as meaningless.`
      : `1 CPU work unit = ${scaled} SHA-256 rounds ~= ${round2(measured)} ms on this machine's cores.`
  };
}

// -------------------------------------------------------------- timer floor
//
// Measured during this chapter's build, on Windows 11:
//
//   asked   5 ms  ->  got p50  8.32 ms, max 20.53 ms
//   asked  20 ms  ->  got p50 21.14 ms, max 31.95 ms
//
// Windows' default timer resolution is ~15.6 ms. A process can request 1 ms
// with timeBeginPeriod - and Chrome does exactly that - so the accuracy of your
// own benchmark depends on whether a browser happens to be open. That is a
// spectacular reproducibility hazard and it is worth knowing about before it
// eats an afternoon.
//
// The consequence for this lab: any `downstreamMs` below roughly 15 ms is not
// the number you asked for. So the lab measures its own floor and refuses to
// use a value underneath it.
export async function calibrateTimer() {
  const probe = async (target, n = 15) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await sleep(target);
      s.push(performance.now() - t0);
    }
    return { target, p50: round2(median(s)), max: round2(Math.max(...s)) };
  };

  const small = await probe(1);
  const mid = await probe(5);
  const safe = await probe(20);

  const overshootPct = ((mid.p50 - 5) / 5) * 100;
  // If a 5 ms sleep overshoots by more than a quarter, the platform timer is
  // coarse and short waits cannot be trusted.
  const coarse = overshootPct > 25;

  return {
    samples: [small, mid, safe],
    overshootAt5msPct: round2(overshootPct),
    coarse,
    // Below this, a requested wait is mostly platform rounding.
    floorMs: coarse ? 20 : 5,
    note: coarse
      ? `This platform's timer is coarse: a 5 ms sleep actually took ${mid.p50} ms (max ${mid.max} ms). Downstream waits are clamped to 20 ms so that the number you set is the number you get. On Windows this is the ~15.6 ms default timer resolution, and it changes if another process (Chrome, for one) raises it.`
      : `Timer resolution is fine here: a 5 ms sleep took ${mid.p50} ms.`
  };
}

// ---------------------------------------------------------- thermal reference
//
// A sustained multi-core load on a laptop throttles within roughly 30-90
// seconds. If a sweep runs 1, 2, 4, 8... workers in ascending order, thermal
// drift puts a monotonic downward trend on the data and it reads exactly like
// diminishing returns. An entire vertical-scaling lesson could be a cooling
// artifact and look completely convincing.
//
// So: a fixed single-threaded probe runs before the sweep, between every point,
// and at the end. If it degrades against the opening probe, the run is flagged
// rather than reported. Twenty lines of code, and the difference between a lab
// and a rumour.
export function referenceProbe(rounds) {
  const t0 = performance.now();
  burn(rounds);
  return round2(performance.now() - t0);
}

export function thermalVerdict(baselineMs, samples) {
  if (!samples.length) return { drifted: false, worstPct: 0, note: 'no probes taken' };

  const worst = Math.max(...samples);
  const pct = ((worst - baselineMs) / baselineMs) * 100;

  // A negative figure means the probe got FASTER as the run went on, which is
  // warm-up (V8 tier-up, caches filling, clocks boosting) rather than throttling.
  // It is not a thermal problem, but it is still a reason not to trust the first
  // points of a sweep - which is a large part of why sweeps are interleaved.
  const warmedUp = pct < -5;

  return {
    baselineMs: round2(baselineMs),
    worstMs: round2(worst),
    worstPct: round2(pct),
    // 5% is deliberately tight. The point is to catch drift while it is still
    // small enough to be mistaken for a result.
    drifted: pct > 5,
    warmedUp,
    note: pct > 5
      ? `The reference probe slowed by ${round2(pct)}% during this run, so the machine was throttling or contended. Treat the downward slope in these numbers as suspect - let the machine cool, repeat, and compare.`
      : warmedUp
        ? `The reference probe got ${round2(Math.abs(pct))}% faster during this run - the machine was still warming up when the baseline was taken, not throttling. No thermal problem, but the earliest points of a sweep are the least trustworthy for this reason.`
        : `The reference probe stayed within ${round2(Math.abs(pct))}% for the whole run, so thermal drift did not shape these numbers.`
  };
}

// Sweeps must not run in ascending order, or thermal drift and the independent
// variable move together and become impossible to separate. Interleaving costs
// nothing and removes the confound entirely.
export function interleave(points) {
  const out = [];
  const rest = [...points];
  while (rest.length) {
    out.push(rest.shift());
    if (rest.length) out.push(rest.pop());
  }
  return out;
}
