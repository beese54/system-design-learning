// One load-generating thread. Several of these run inside the driver process.
//
// Uses node:http directly rather than fetch, for two reasons that matter to a
// load generator: an explicit Agent gives exact control over how many
// connections exist (without which "least connections" is a fiction, because
// there is no queue to measure), and it skips a layer of overhead in the
// hottest loop in the lab.
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';

const {
  host, port, path,
  mode,              // 'closed' | 'open'
  concurrency,       // closed loop: how many requests in flight
  ratePerSec,        // open loop: arrivals per second
  durationMs,
  warmupMs,
  expectedSamples
} = workerData;

// Keep-alive is not an optimisation here, it is a correctness requirement.
// Windows' dynamic port range is 16,384 wide and TIME_WAIT lasts 120 seconds,
// which caps sustained NEW connections at roughly 136/second. Without reuse a
// run dies of ephemeral port exhaustion about two minutes in, and the symptom
// looks exactly like the server failing.
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: mode === 'closed' ? concurrency : Math.max(64, Math.ceil(ratePerSec / 4)),
  maxFreeSockets: 256
});

// Pre-allocated, so the hot loop allocates nothing. Pushing to a JS array
// during measurement triggers GC pauses that land in the tail latency you are
// trying to measure, and they get attributed to the server.
const latency = new Float64Array(expectedSamples);
const queued = new Float64Array(expectedSamples);   // open loop: intended -> completed
let n = 0;
let errors = 0;
let statusNon2xx = 0;
const byInstance = new Map();

function record(ms, sinceIntended, status, instance) {
  if (n < expectedSamples) {
    latency[n] = ms;
    queued[n] = sinceIntended;
    n++;
  }
  if (status === 0) errors++;
  else if (status >= 300) statusNon2xx++;
  if (instance) byInstance.set(instance, (byInstance.get(instance) || 0) + 1);
}

function hit() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request({ host, port, path, agent, method: 'GET' }, (res) => {
      // Drain the body. An undrained response keeps the socket busy and the
      // next request on it silently queues behind data nobody read.
      res.resume();
      res.on('end', () => resolve({
        ms: performance.now() - t0,
        status: res.statusCode,
        instance: res.headers['x-lab-instance']
      }));
    });
    req.on('error', () => resolve({ ms: performance.now() - t0, status: 0 }));
    req.end();
  });
}

// Closed loop: a fixed number of requests in flight, each thread sending the
// next one only when the last comes back.
//
// This is what finds maximum throughput, and it is what almost every simple
// benchmark does. What it CANNOT do is measure queueing delay: when the server
// slows down, the client slows down with it, so the queue never forms. That is
// why the Health and Failure tabs use the open loop instead.
async function closedLoop(stopAt) {
  const workers = Array.from({ length: concurrency }, async () => {
    while (performance.now() < stopAt) {
      const r = await hit();
      if (performance.now() >= warmUntil) record(r.ms, r.ms, r.status, r.instance);
    }
  });
  await Promise.all(workers);
}

// Open loop: requests depart on a schedule regardless of whether earlier ones
// have come back. This is how real traffic behaves - your users do not wait for
// each other - and it is the only way to see a queue build.
//
// The intended departure time is computed BEFORE the request is scheduled, and
// latency is measured from that intended time rather than from when the request
// actually left. That difference is the coordinated-omission correction: without
// it, a server that stalls for a second simply produces fewer samples, and the
// stall vanishes from the percentiles instead of dominating them.
//
// Pacing is batched rather than per-request because a Windows sleep cannot
// resolve intervals below ~15.6 ms. Asking for a 1 ms gap yields 4-15 ms and
// wrecks the arrival schedule; waking on a coarse boundary and firing everything
// that is now due keeps the AVERAGE rate correct, which is what matters.
async function openLoop(stopAt) {
  const interval = 1000 / ratePerSec;
  const started = performance.now();
  const inflight = new Set();
  let i = 0;
  let pacingError = 0;
  let pacingSamples = 0;

  while (performance.now() < stopAt) {
    const now = performance.now();
    const intended = started + i * interval;

    if (intended > now) {
      // Sleep to the next due time, but never for less than the platform can
      // actually deliver - a shorter sleep just burns a scheduler slot.
      await sleep(Math.max(1, Math.min(intended - now, 16)));
      continue;
    }

    pacingError += now - intended;
    pacingSamples++;

    const p = hit().then((r) => {
      const completedAt = performance.now();
      if (completedAt >= warmUntil) {
        // Service time, and the time the caller actually waited.
        record(r.ms, completedAt - intended, r.status, r.instance);
      }
      inflight.delete(p);
    });
    inflight.add(p);
    i++;
  }

  await Promise.allSettled([...inflight]);
  return {
    intended: i,
    pacingErrorMs: pacingSamples ? pacingError / pacingSamples : 0
  };
}

const warmUntil = performance.now() + warmupMs;

const run = async () => {
  const stopAt = performance.now() + warmupMs + durationMs;
  const t0 = performance.now();
  const extra = mode === 'open' ? await openLoop(stopAt) : (await closedLoop(stopAt), {});
  const elapsed = performance.now() - t0 - warmupMs;

  parentPort.postMessage({
    samples: latency.slice(0, n),
    queueing: queued.slice(0, n),
    count: n,
    errors,
    statusNon2xx,
    elapsedMs: elapsed,
    rps: n / (elapsed / 1000),
    byInstance: [...byInstance.entries()],
    ...extra
  });
};

run();
