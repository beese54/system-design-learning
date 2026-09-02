// The ejection state machine.
//
//   healthy --(N consecutive failures)--> ejected
//   ejected --(fail_timeout elapsed)----> probing
//   probing --(M consecutive successes)-> healthy, at a ramped weight
//
// Every parameter here is a decision with a cost, so each one is named rather
// than buried. The defaults are close to what nginx and Envoy ship, which is
// why Tab 8 can put this file and an nginx.conf side by side and have the
// comparison mean something.
export const DEFAULTS = {
  // How often to probe. Faster finds failure sooner and costs more requests.
  intervalMs: 500,
  // A probe that takes longer than this counts as failed. This is the single
  // most important number in the file: it is what separates "dead" (refused in
  // microseconds) from "hung" (accepted and abandoned, invisible until this
  // fires). A TCP check has no equivalent, which is why a TCP check is useless.
  timeoutMs: 250,
  // Consecutive failures before ejection. 1 would eject on a single blip;
  // 3 costs 1.5 seconds of detection and removes almost all false positives.
  ejectAfter: 3,
  // Consecutive successes before returning. Asymmetric on purpose: quick to
  // remove, slow to trust again. This asymmetry IS hysteresis, and it is what
  // stops a flapping backend oscillating in and out of the pool.
  restoreAfter: 2,
  // How long to wait before probing an ejected backend again.
  probeAfterMs: 5000,
  // A returning backend gets a linearly increasing share over this window.
  // Without it, a cold process with empty caches and an unwarmed JIT receives
  // a full share of traffic immediately and fails again - which is exactly the
  // oscillation the state machine was meant to prevent.
  rampMs: 10000,
  // Never eject more than this fraction of the fleet, no matter what the checks
  // say. Borrowed from Envoy, and it is the difference between a degraded
  // service and no service at all: if every backend fails its check at once the
  // cause is almost certainly shared - a dependency, or the check itself - and
  // removing all of them helps nobody. Lesson 06 breaks the fleet on purpose to
  // watch this refuse to make it worse.
  panicThreshold: 0.5,
  // Which endpoint to probe. The whole cascade lesson lives in this one string:
  //   /healthz  liveness only - is the process alive
  //   /readyz   readiness     - should it get traffic
  //   /deepz    dependency    - can it reach the database
  // Point this at /deepz, blip the shared database, and a naive balancer ejects
  // the entire fleet for a fault that broke nothing in any instance.
  path: '/readyz'
};

export function createChecker(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const nodes = new Map();
  const events = [];

  const now = () => Date.now();

  const log = (id, type, detail) => {
    events.push({ at: now(), id, type, detail });
    if (events.length > 500) events.shift();
  };

  function add(id, port) {
    if (nodes.has(id)) return;
    nodes.set(id, {
      id, port,
      status: 'healthy',
      consecutiveFail: 0,
      consecutivePass: 0,
      ejectedAt: null,
      restoredAt: null,
      probes: 0,
      failures: 0,
      lastMs: null,
      lastError: null
    });
    log(id, 'added', 'joined the pool');
  }

  function remove(id) {
    nodes.delete(id);
    log(id, 'removed', 'left the pool');
  }

  // A backend returning from ejection is trusted gradually. Weight climbs from
  // near zero to 1 across the ramp window; the balancer multiplies its chance
  // of being chosen by this.
  function weight(n) {
    if (n.status !== 'healthy') return 0;
    if (!n.restoredAt) return 1;
    const age = now() - n.restoredAt;
    if (age >= cfg.rampMs) return 1;
    return Math.max(0.05, age / cfg.rampMs);
  }

  const healthyCount = () => [...nodes.values()].filter((n) => n.status === 'healthy').length;

  // Panic mode: if ejecting one more would take the pool below the threshold,
  // refuse. Returning half a broken fleet's traffic to backends that might work
  // beats returning all of it to nothing.
  function inPanic() {
    const total = nodes.size;
    if (total === 0) return false;
    return healthyCount() <= Math.ceil(total * cfg.panicThreshold);
  }

  async function probeOne(n) {
    const started = performance.now();
    try {
      const res = await fetch('http://127.0.0.1:' + n.port + cfg.path, {
        signal: AbortSignal.timeout(cfg.timeoutMs)
      });
      n.lastMs = Math.round((performance.now() - started) * 100) / 100;
      n.probes++;
      if (res.ok) return pass(n);
      return fail(n, 'status ' + res.status);
    } catch (err) {
      n.lastMs = Math.round((performance.now() - started) * 100) / 100;
      n.probes++;
      // A refused connection and a timeout are both failures, but they arrive
      // orders of magnitude apart, and the lesson wants that visible.
      return fail(n, err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.name));
    }
  }

  function pass(n) {
    n.consecutiveFail = 0;
    n.consecutivePass++;
    // Clear the stale reason. Without this a node that failed once and then
    // recovered keeps reporting its old error forever, and the next experiment
    // on that node reads it as a fresh diagnosis of something else entirely.
    n.lastError = null;
    if ((n.status === 'ejected' || n.status === 'probing') && n.consecutivePass >= cfg.restoreAfter) {
      n.status = 'healthy';
      n.restoredAt = now();
      n.ejectedAt = null;
      log(n.id, 'restored', `${n.consecutivePass} consecutive passes; ramping in over ${cfg.rampMs} ms`);
    }
  }

  function fail(n, why) {
    n.failures++;
    n.consecutivePass = 0;
    n.consecutiveFail++;
    n.lastError = why;

    if (n.status === 'healthy' && n.consecutiveFail >= cfg.ejectAfter) {
      if (inPanic()) {
        log(n.id, 'panic', `would eject (${n.consecutiveFail} failures: ${why}) but that would drop the pool below ${cfg.panicThreshold * 100}% healthy - keeping it in rotation`);
        return;
      }
      n.status = 'ejected';
      n.ejectedAt = now();
      n.restoredAt = null;
      log(n.id, 'ejected', `${n.consecutiveFail} consecutive failures (${why})`);
    }
  }

  async function tick() {
    const jobs = [];
    for (const n of nodes.values()) {
      if (n.status === 'ejected') {
        // Not yet time to look again.
        if (now() - n.ejectedAt < cfg.probeAfterMs) continue;
        n.status = 'probing';
        log(n.id, 'probing', 'fail timeout elapsed, trying again');
      }
      jobs.push(probeOne(n));
    }
    await Promise.allSettled(jobs);
  }

  let timer = null;
  const start = () => { if (!timer) timer = setInterval(tick, cfg.intervalMs); };
  const stop = () => { clearInterval(timer); timer = null; };

  // Passive health: what real traffic saw. Active probes ask a backend whether
  // it is well; passive signal is whether it actually served anyone. The zombie
  // case is exactly why both are needed - it passes every probe and fails every
  // real request.
  function observe(id, ok) {
    const n = nodes.get(id);
    if (!n) return;
    if (ok) { n.consecutiveFail = 0; return; }
    fail(n, 'real request failed');
  }

  return {
    cfg,
    add,
    remove,
    start,
    stop,
    tick,
    observe,
    weight,
    inPanic,
    eligible: () => [...nodes.values()].filter((n) => n.status === 'healthy'),
    snapshot: () => ({
      config: cfg,
      panic: inPanic(),
      healthy: healthyCount(),
      total: nodes.size,
      nodes: [...nodes.values()].map((n) => ({
        id: n.id, port: n.port, status: n.status,
        weight: Math.round(weight(n) * 100) / 100,
        consecutiveFail: n.consecutiveFail,
        probes: n.probes, failures: n.failures,
        lastMs: n.lastMs, lastError: n.lastError,
        ejectedForMs: n.ejectedAt ? now() - n.ejectedAt : null
      })),
      events: events.slice(-40)
    }),
    clearEvents: () => { events.length = 0; }
  };
}
