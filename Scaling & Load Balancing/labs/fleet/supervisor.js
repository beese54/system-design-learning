// Starts, stops, breaks and drains the fleet.
//
// This is the thing an orchestrator would do for you in production. It is here
// in ~200 readable lines so that when Lesson 08 talks about warm-up, cooldown
// and drain, you have already seen the mechanism rather than a vendor's word
// for it.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTANCE = join(HERE, 'instance.js');

// 4311 upward. Wide enough for a fleet on a large machine: a range of 8 would
// have become a hard cap that the lesson prose then had to apologise for.
export const PORT_BASE = 4311;
export const PORT_MAX = 4342;

const fleet = new Map(); // id -> record

const round2 = (n) => Math.round(n * 100) / 100;

export const list = () =>
  [...fleet.values()].map((r) => ({
    id: r.id, port: r.port, pid: r.pid, workers: r.workers,
    state: r.state, ready: r.ready, startedAt: r.startedAt
  }));

export const urlOf = (id) => 'http://127.0.0.1:' + fleet.get(id).port;

function nextPort() {
  const taken = new Set([...fleet.values()].map((r) => r.port));
  for (let p = PORT_BASE; p <= PORT_MAX; p++) if (!taken.has(p)) return p;
  return null;
}

// Readiness is asked of the instance, not assumed from the fact that we forked
// it. The whole chapter is about the difference between "the process exists"
// and "the process can serve", so the supervisor had better not confuse them.
async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/readyz', {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

export async function spawnOne({ workers = 1, rounds, id } = {}) {
  const port = nextPort();
  if (port === null) return { ok: false, error: `No free port in ${PORT_BASE}-${PORT_MAX}. The fleet is already at its maximum size.` };

  const instanceId = id || 'i' + (port - PORT_BASE + 1);
  if (fleet.has(instanceId)) return { ok: false, error: 'Instance already running: ' + instanceId };

  // fork(), not spawn(). fork gives an IPC channel, and the IPC channel is what
  // lets a child notice that its parent has died - see the 'disconnect' handler
  // in instance.js. Without it, a hard kill of the lab host leaves orphans
  // holding ports and the next start fails for a reason that looks unrelated.
  const child = fork(INSTANCE, [
    '--id=' + instanceId,
    '--port=' + port,
    '--workers=' + workers
  ], {
    // 128 MB is generous for a service this small, and it turns a memory leak
    // into a visible crash instead of a machine that quietly starts paging.
    // Paging is the dangerous failure here: it corrupts exactly the tail-latency
    // numbers this chapter is built on, and it looks like a scaling limit.
    execArgv: ['--max-old-space-size=128'],
    env: { ...process.env, HASH_ROUNDS: String(rounds || process.env.HASH_ROUNDS || 12000) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });

  const record = {
    id: instanceId, port, workers, pid: child.pid,
    child, state: 'healthy', ready: false, startedAt: Date.now()
  };
  fleet.set(instanceId, record);

  child.on('exit', () => {
    const cur = fleet.get(instanceId);
    if (cur && cur.child === child) cur.ready = false;
  });

  const ready = await waitReady(port);
  record.ready = ready;

  if (!ready) {
    child.kill();
    fleet.delete(instanceId);
    return { ok: false, error: `Instance ${instanceId} did not become ready on port ${port} within 20s.` };
  }

  return { ok: true, id: instanceId, port, pid: child.pid, workers };
}

// Kill: abrupt, the way a machine failing is abrupt. On Windows there is no
// graceful SIGTERM to send - kill() calls TerminateProcess whatever signal name
// you pass - so this really is a hard stop, and that honesty is the point.
export function killOne(id) {
  const r = fleet.get(id);
  if (!r) return { ok: false, error: 'Unknown instance: ' + id };
  r.child.kill();
  fleet.delete(id);
  return { ok: true, id, killed: true };
}

// Drain: the civilised version. Stop accepting, finish what is in flight, then
// exit. On Linux an orchestrator gets this by sending SIGTERM and waiting; on
// Windows there is no such contract, so it has to be asked for at the
// application layer. Either way the thing that actually matters is the same -
// the balancer must stop sending you traffic BEFORE you stop accepting it.
export async function drainOne(id, graceMs = 6000) {
  const r = fleet.get(id);
  if (!r) return { ok: false, error: 'Unknown instance: ' + id };

  const t0 = performance.now();
  r.state = 'draining';
  r.ready = false;
  r.child.send({ type: 'drain' });

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (r.child.exitCode !== null || r.child.killed) break;
    await sleep(50);
  }

  const cleanly = r.child.exitCode !== null;
  if (!cleanly) r.child.kill();
  fleet.delete(id);

  return { ok: true, id, drained: true, cleanly, ms: round2(performance.now() - t0) };
}

export async function inject(id, state, opts = {}) {
  const r = fleet.get(id);
  if (!r) return { ok: false, error: 'Unknown instance: ' + id };

  const params = new URLSearchParams({ state, ...opts });
  try {
    const res = await fetch(urlOf(id) + '/inject?' + params, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });
    r.state = state;
    // A dead instance stops answering by design; readiness follows.
    if (state === 'dead' || state === 'hung') r.ready = false;
    return await res.json();
  } catch (err) {
    // `dead` closes its listener, so the response to the very request that
    // killed it may never arrive. That is correct behaviour, not a failure.
    if (state === 'dead' || state === 'hung') {
      r.state = state;
      r.ready = false;
      return { ok: true, id, state, note: 'instance stopped answering, as intended' };
    }
    return { ok: false, error: String(err.message || err) };
  }
}

export async function revive(id, warmMs = 4000) {
  const r = fleet.get(id);
  if (!r) return { ok: false, error: 'Unknown instance: ' + id };
  try {
    const res = await fetch(urlOf(id) + '/revive?warmMs=' + warmMs, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });
    r.state = 'healthy';
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// Resize the fleet to exactly n instances of the given shape. Used by every
// sweep, which is why it returns timings: how long a fleet takes to come up is
// itself one of the numbers Lesson 08 needs.
export async function scale(n, { workers = 1, rounds } = {}) {
  const t0 = performance.now();
  const errors = [];

  while (fleet.size > n) {
    const last = [...fleet.keys()].pop();
    killOne(last);
  }
  while (fleet.size < n) {
    const out = await spawnOne({ workers, rounds });
    if (!out.ok) { errors.push(out.error); break; }
  }

  // Reshape survivors whose worker count is wrong - a worker count change means
  // a restart, which is exactly what it would mean in production.
  for (const r of [...fleet.values()]) {
    if (r.workers !== workers) {
      killOne(r.id);
      const out = await spawnOne({ workers, rounds });
      if (!out.ok) errors.push(out.error);
    }
  }

  return {
    ok: errors.length === 0,
    size: fleet.size,
    workers,
    ms: round2(performance.now() - t0),
    errors,
    instances: list()
  };
}

export async function stats() {
  const out = [];
  for (const r of fleet.values()) {
    try {
      const res = await fetch(urlOf(r.id) + '/stats', { signal: AbortSignal.timeout(1500) });
      out.push(await res.json());
    } catch {
      out.push({ id: r.id, port: r.port, state: r.state, unreachable: true });
    }
  }
  return out;
}

export function killAll() {
  const ids = [...fleet.keys()];
  for (const id of ids) {
    try { fleet.get(id).child.kill(); } catch { /* already gone */ }
  }
  fleet.clear();
  return { ok: true, killed: ids.length };
}

// A port left occupied by a previous run is the most confusing possible startup
// failure: EADDRINUSE on a port this code has never used in this process. Rather
// than blind-killing whatever holds it, ask - the lab's own instances identify
// themselves, and anything else is somebody else's process and must be left alone.
export async function surveyPorts() {
  const found = [];
  for (let p = PORT_BASE; p <= PORT_MAX; p++) {
    try {
      const res = await fetch('http://127.0.0.1:' + p + '/stats', { signal: AbortSignal.timeout(250) });
      const body = await res.json();
      if (body && body.id) found.push({ port: p, id: body.id, pid: body.pid, ours: true });
    } catch { /* nothing listening, which is the normal case */ }
  }
  return found;
}
