// The load generator, and the honesty checks around it.
//
// Runs in its own process, forked by the lab host, with N worker threads inside
// it. Not in the lab host: that process serves the UI and the control plane, and
// its event-loop turns would land directly in these timestamps.
//
// Runnable alone, which is the quickest way to see it work:
//   node load/driver.js --url=http://127.0.0.1:4311/work?mode=cpu --concurrency=8
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import os from 'node:os';
import { summarise, acrossRuns } from './histogram.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.js');

const round2 = (n) => Math.round(n * 100) / 100;

// The driver gets its own cores, but only a few: it is an instrument, not the
// subject. Four threads saturate anything this lab can produce.
export const threadCount = () => Math.min(4, Math.max(1, Math.floor(os.cpus().length / 8)));

function spawnWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: data });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
}

/**
 * One measurement. Returns latency statistics, throughput, per-instance
 * distribution, and - for open-loop runs - the coordinated-omission correction.
 */
export async function measure({
  url,
  mode = 'closed',          // 'closed' finds capacity; 'open' shows queueing
  concurrency = 8,
  ratePerSec = 200,
  durationMs = 5000,
  warmupMs = 1500,
  threads = threadCount()
} = {}) {
  const u = new URL(url);
  const perThread = mode === 'closed'
    ? Math.max(1, Math.round(concurrency / threads))
    : concurrency;
  const perThreadRate = ratePerSec / threads;

  // Generously sized so the hot loop never reallocates. 20k rps for the whole
  // window would be extraordinary here, and over-allocating a Float64Array
  // costs 8 bytes a slot.
  const expectedSamples = Math.max(1000, Math.ceil((durationMs / 1000) * 25000 / threads));

  const results = await Promise.all(
    Array.from({ length: threads }, () => spawnWorker({
      host: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      mode,
      concurrency: perThread,
      ratePerSec: perThreadRate,
      durationMs,
      warmupMs,
      expectedSamples
    }))
  );

  // Merge by CONCATENATING samples, never by averaging each thread's
  // percentiles. Averaging percentiles is a classic and it is wrong: the mean of
  // four p99s is not the p99 of the combined population.
  const all = [];
  const allQueue = [];
  const byInstance = new Map();
  let errors = 0, statusNon2xx = 0, rps = 0, intended = 0, pacingErr = 0;

  for (const r of results) {
    for (const v of r.samples) all.push(v);
    for (const v of r.queueing) allQueue.push(v);
    errors += r.errors;
    statusNon2xx += r.statusNon2xx;
    rps += r.rps || 0;
    intended += r.intended || 0;
    pacingErr += r.pacingErrorMs || 0;
    for (const [k, v] of r.byInstance) byInstance.set(k, (byInstance.get(k) || 0) + v);
  }

  const service = summarise(all);
  const waited = summarise(allQueue);
  const total = all.length + errors;

  return {
    ok: true,
    mode,
    concurrency: mode === 'closed' ? concurrency : null,
    ratePerSec: mode === 'open' ? ratePerSec : null,
    threads,
    durationMs,
    count: all.length,
    errors,
    statusNon2xx,
    errorRatePct: total ? round2(((errors + statusNon2xx) / total) * 100) : 0,
    rps: round2(rps),
    // Service time: how long the server took once the request left.
    service,
    // What the caller actually waited, measured from the INTENDED departure
    // time rather than the actual one.
    waited: mode === 'open' ? waited : null,
    // The distance between those two is not the coordinated-omission story -
    // it is a check on the instrument. This driver never blocks dispatch, so a
    // healthy run has a gap near zero even under heavy overload (measured at
    // 0.16 ms while the server was five times oversubscribed). A gap that grows
    // means the DRIVER fell behind its own schedule and the run is suspect.
    //
    // The coordinated-omission lesson lives one level up, in comparing a closed
    // loop against an open one at the same offered load: closed loop p99 130 ms
    // versus open loop p99 22,597 ms on an identical single instance. The closed
    // loop did not measure a faster server, it just stopped asking.
    dispatchDelayMs: mode === 'open' && service.p99 && waited.p99
      ? round2(waited.p99 - service.p99)
      : null,
    driverKeptUp: mode === 'open' && service.p99 && waited.p99
      ? (waited.p99 - service.p99) < Math.max(20, service.p50 || 0)
      : null,
    pacingErrorMs: mode === 'open' ? round2(pacingErr / results.length) : null,
    distribution: [...byInstance.entries()]
      .map(([id, n]) => ({ id, n, pct: round2((n / all.length) * 100) }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

/**
 * What can this load generator do against a target that does nothing at all?
 *
 * Every other number in the chapter is meaningless without this one. A run that
 * approaches the driver's own ceiling is measuring the driver, and almost no
 * course checks. The 70% rule below is applied in code rather than offered as
 * advice, so a tab cannot quietly report an instrument-limited result.
 */
export async function selfTest(pingUrl, { durationMs = 3000 } = {}) {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    runs.push(await measure({ url: pingUrl, mode: 'closed', concurrency: 64, durationMs, warmupMs: 800 }));
  }
  const best = Math.max(...runs.map((r) => r.rps));
  const spread = acrossRuns(runs.map((r) => r.rps));

  return {
    ceilingRps: round2(best),
    safeRps: round2(best * 0.7),
    p99AtCeilingMs: runs[runs.length - 1].service.p99,
    threads: runs[0].threads,
    repeatSpreadPct: spread.spreadPct,
    note: `This load generator tops out at about ${Math.round(best).toLocaleString('en-US')} requests/second against an endpoint that does nothing. Any measurement above ${Math.round(best * 0.7).toLocaleString('en-US')} rps is within 70% of that ceiling and is telling you more about the driver than about the fleet - the lab marks those runs instrument-limited rather than reporting them.`
  };
}

/**
 * The coordinated-omission demonstration, as a measured pair rather than an
 * assertion.
 *
 * Same target, same work, same duration. The closed loop holds a fixed number
 * of requests in flight, so when the server slows down the client slows down
 * with it and the queue never forms. The open loop keeps arriving on schedule
 * the way real users do, and the queue is immediately visible.
 *
 * Run this once against a saturated instance and the two p99s differ by two
 * orders of magnitude. That is not a faster server - it is a client that
 * stopped asking.
 */
export async function compareLoops({ url, concurrency = 8, ratePerSec, durationMs = 5000 }) {
  const closed = await measure({ url, mode: 'closed', concurrency, durationMs });
  // Offer the open loop the same load the closed loop actually achieved, unless
  // told otherwise. Comparing at the same OFFERED rate is the only fair test.
  const rate = ratePerSec || Math.round(closed.rps);
  const open = await measure({ url, mode: 'open', ratePerSec: rate, durationMs });

  const ratio = closed.service.p99 ? round2(open.waited.p99 / closed.service.p99) : null;

  return {
    offeredRps: rate,
    closed: { rps: closed.rps, p50: closed.service.p50, p99: closed.service.p99 },
    open: { rps: open.rps, p50: open.waited.p50, p99: open.waited.p99 },
    ratio,
    readMe: ratio && ratio > 2
      ? `At the same offered load, the closed loop reports a p99 of ${closed.service.p99} ms and the open loop ${open.waited.p99} ms - ${ratio} times worse. The server did not change between those two runs. The closed loop simply waited for each response before sending the next request, so the queue that real traffic would have formed never existed. This is coordinated omission, and it is why load-test results are so often cheerfully wrong.`
      : `Closed and open loops agree here (p99 ${closed.service.p99} ms versus ${open.waited.p99} ms), which is what you expect while the server is comfortably below capacity. Push the rate past capacity and they will diverge sharply.`
  };
}

/** Was this run measuring the fleet, or the instrument? */
export function instrumentLimited(result, ceiling) {
  if (!ceiling || !result?.rps) return { limited: false };
  const pct = (result.rps / ceiling.ceilingRps) * 100;
  return {
    limited: result.rps > ceiling.safeRps,
    pctOfCeiling: round2(pct),
    note: result.rps > ceiling.safeRps
      ? `This run reached ${round2(pct)}% of the load generator's own ceiling, so the number is at least partly the instrument. Lower the concurrency, or make each request do more work, and run it again.`
      : `Comfortably inside the instrument's range at ${round2(pct)}% of its ceiling.`
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith('/' + basename(process.argv[1]));

if (invokedDirectly) {
  const arg = (k, d) => {
    const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const out = await measure({
    url: arg('url', 'http://127.0.0.1:4311/work?mode=io:query'),
    mode: arg('mode', 'closed'),
    concurrency: Number(arg('concurrency', 8)),
    ratePerSec: Number(arg('rate', 200)),
    durationMs: Number(arg('ms', 5000))
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
