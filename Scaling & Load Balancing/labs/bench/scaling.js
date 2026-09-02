// Tabs 2 and 3 - Vertical and Horizontal.
//
// These two tabs share a module because they are the same experiment with one
// variable swapped, and keeping them side by side in one file is the only
// honest way to write them: the interesting result is the COMPARISON, and a
// reader who sees only one of the two curves will draw the wrong conclusion
// from it.
import { measure, instrumentLimited } from '../load/driver.js';
import { interleave, referenceProbe, thermalVerdict } from '../load/calibrate.js';
import { lab, sup, ensureFleet, workPath, preflight, lbUrl } from './state.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Enough in-flight work to keep every worker busy, without piling on so much
// that the queue dominates. Four per unit of parallelism is comfortably past
// saturation and still inside the driver's range.
const concurrencyFor = (parallelism) => Math.max(4, parallelism * 4);

async function sweepPoint({ url, parallelism, durationMs }) {
  const r = await measure({
    url,
    concurrency: concurrencyFor(parallelism),
    durationMs,
    warmupMs: 900
  });
  return {
    rps: r.rps,
    p50: r.service.p50,
    p95: r.service.p95,
    p99: r.service.p99,
    errors: r.errors,
    distribution: r.distribution,
    instrument: instrumentLimited(r, lab.ceiling)
  };
}

function efficiency(points) {
  if (!points.length) return points;
  const base = points[0].rps;
  return points.map((p) => ({
    ...p,
    speedup: round2(p.rps / base),
    // Perfect scaling would keep this at 1. Watching it fall is watching the
    // return on each additional unit of parallelism disappear.
    efficiency: round2((p.rps / base) / p.n)
  }));
}

/**
 * Vertical: one instance, more workers inside it.
 *
 * `cluster` forks N workers that share one listening socket. This is what
 * "buy a bigger box" looks like from inside the process.
 */
export async function vertical({ mode = 'cpu', durationMs = 3500 } = {}) {
  if (!lab.cpu) await preflight();
  const sweep = lab.budget.sweep;
  const probeBase = referenceProbe(lab.cpu.rounds);
  const probes = [];
  const points = [];

  for (const n of interleave(sweep)) {
    await ensureFleet(1, n);
    const inst = sup.list()[0];
    const url = 'http://127.0.0.1:' + inst.port + workPath({ mode, downstreamMs: 0 });
    const r = await sweepPoint({ url, parallelism: n, durationMs });
    points.push({ n, workers: n, instances: 1, ...r });
    probes.push(referenceProbe(lab.cpu.rounds));
  }

  points.sort((a, b) => a.n - b.n);
  const withEff = efficiency(points);
  const thermal = thermalVerdict(probeBase, probes);
  const best = withEff.reduce((a, b) => (b.rps > a.rps ? b : a), withEff[0]);

  return {
    axis: 'vertical',
    mode,
    cores: lab.budget.cores,
    fleetBudget: lab.budget.fleet,
    workUnitMs: lab.cpu.measuredMs,
    points: withEff,
    best: { workers: best.n, rps: best.rps, speedup: best.speedup },
    thermal,
    readMe: buildRead('workers inside one instance', withEff, lab, thermal)
  };
}

/**
 * Horizontal: more instances, one worker each.
 *
 * Same total parallelism as the vertical sweep at every point, so the two
 * curves are directly comparable. Any difference between them is the cost of
 * process boundaries and an extra network hop - not a difference in how much
 * CPU is available.
 */
export async function horizontal({ mode = 'cpu', durationMs = 3500 } = {}) {
  if (!lab.cpu) await preflight();
  const sweep = lab.budget.sweep;
  const probeBase = referenceProbe(lab.cpu.rounds);
  const probes = [];
  const points = [];

  for (const n of interleave(sweep)) {
    await ensureFleet(n, 1);
    const url = lbUrl(workPath({ mode, downstreamMs: 0 }));
    const r = await sweepPoint({ url, parallelism: n, durationMs });
    points.push({ n, workers: 1, instances: n, ...r });
    probes.push(referenceProbe(lab.cpu.rounds));
  }

  points.sort((a, b) => a.n - b.n);
  const withEff = efficiency(points);
  const thermal = thermalVerdict(probeBase, probes);
  const best = withEff.reduce((a, b) => (b.rps > a.rps ? b : a), withEff[0]);

  return {
    axis: 'horizontal',
    mode,
    cores: lab.budget.cores,
    fleetBudget: lab.budget.fleet,
    points: withEff,
    best: { instances: best.n, rps: best.rps, speedup: best.speedup },
    thermal,
    readMe: buildRead('instances behind the balancer', withEff, lab, thermal)
  };
}

function buildRead(what, points, labRef, thermal) {
  const first = points[0];
  const last = points[points.length - 1];
  const ideal = last.n;
  const got = last.speedup;

  let s = `Scaling ${what} from 1 to ${last.n} took throughput from ${first.rps} to ${last.rps} rps - ` +
    `a speedup of ${got} against a theoretical ${ideal}, so ${Math.round(last.efficiency * 100)}% efficiency at the top of the sweep. `;

  if (labRef.budget.smallMachine) {
    s += `This machine only has ${labRef.budget.fleet} core(s) free for the fleet, so the sweep is short and the knee will be shallow. ` +
      `The shape is the lesson, not the absolute numbers. `;
  }
  if (thermal.drifted) {
    s += `Treat this run with suspicion: ${thermal.note} `;
  }
  return s;
}

/**
 * THE control experiment.
 *
 * This is the most important measurement in the chapter, and it exists because
 * the obvious version of the horizontal-scaling lesson is false.
 *
 * On an I/O-bound service, one Node process can hold hundreds of requests in
 * flight - it is doing nothing between sending a query and getting the answer.
 * So when you add instances and throughput rises, the causal variable is not
 * the instance count. It is total concurrency at the dependency. Give ONE
 * instance the same total pool and it keeps up.
 *
 * Which means: horizontally scaling a stateless, I/O-bound tier does not buy
 * throughput. It buys availability, deploy headroom, and a smaller blast
 * radius. Those are excellent reasons. They are not the reason people give.
 *
 * Run the same comparison in `cpu` mode and it inverts, because there the app
 * tier really is the bottleneck.
 */
export async function controlExperiment({ instances = 4, durationMs = 4000 } = {}) {
  if (!lab.cpu) await preflight();
  const n = Math.max(2, Math.min(instances, lab.budget.fleet));
  const out = {};

  for (const mode of ['io:query', 'cpu']) {
    // Many instances, small pool each.
    await ensureFleet(n, 1);
    const many = await measure({
      url: lbUrl(workPath({ mode, downstreamMs: 0 })),
      concurrency: n * 8,
      durationMs,
      warmupMs: 900
    });

    // One instance, same total worker count is NOT the comparison - that would
    // be the vertical sweep. Here it is one instance with the same total
    // request concurrency, to show that concurrency was the variable all along.
    await ensureFleet(1, 1);
    const one = await measure({
      url: 'http://127.0.0.1:' + sup.list()[0].port + workPath({ mode, downstreamMs: 0 }),
      concurrency: n * 8,
      durationMs,
      warmupMs: 900
    });

    out[mode] = {
      many: { instances: n, rps: many.rps, p50: many.service.p50, p99: many.service.p99 },
      one: { instances: 1, rps: one.rps, p50: one.service.p50, p99: one.service.p99 },
      ratio: one.rps ? round2(many.rps / one.rps) : null
    };
  }

  const io = out['io:query'];
  const cpu = out.cpu;

  return {
    instances: n,
    results: out,
    readMe:
      `Same total request concurrency both times; the only change is how many processes serve it.\n\n` +
      `I/O-bound work: ${n} instances managed ${io.many.rps} rps, one instance managed ${io.one.rps} rps - a ratio of ${io.ratio}. ` +
      `${io.ratio !== null && io.ratio < 1
        ? 'The fleet was SLOWER than the single process. One event loop sits idle almost the entire time an I/O-bound request is in flight, so a single process can hold hundreds of them at once - it never needed help. What the fleet added was a proxy hop in front of work that was already free, and the hop costs more than the parallelism returns. Scaling out an I/O-bound tier for throughput does not merely fail to help; it can charge you for the privilege.'
        : io.ratio !== null && io.ratio < 1.5
          ? 'Adding instances bought little or nothing. One event loop is idle almost the whole time an I/O-bound request is in flight, so a single process can hold hundreds of them.'
          : 'Adding instances did help here, which usually means the dependency, the pool, or the balancer became the limit rather than the event loop - worth chasing before concluding the app tier was the bottleneck.'}` +
      `${io.ratio !== null && io.ratio < 1.5
        ? ' None of which is an argument against running more than one. You scale out for availability, for somewhere to deploy without downtime, and to make one machine dying survivable. Those are excellent reasons. Throughput is simply not one of them here.'
        : ''}\n\n` +
      `CPU-bound work: ${n} instances managed ${cpu.many.rps} rps against one instance's ${cpu.one.rps} rps - a ratio of ${cpu.ratio}. ` +
      `Here instance count IS the causal variable, because a single event loop can only burn one core and the work is nothing but core-burning.\n\n` +
      `That inversion is the lesson. "Scale out for throughput" is only true when the app tier is what ran out.`
  };
}
