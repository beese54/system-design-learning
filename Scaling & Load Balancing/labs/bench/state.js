// Shared lab state: one fleet, one balancer, one calibration, for every tab.
//
// Kept in a single module rather than passed around because the tabs are views
// onto ONE running system - changing the fleet in Tab 3 and then looking at
// Tab 4 should show you the fleet you just changed. A lab where each tab owned
// its own private fleet would be eight demos rather than one system.
import * as sup from '../fleet/supervisor.js';
import { createBalancer } from '../lb/balancer.js';
import { budget } from '../load/budget.js';
import { calibrateCpu, calibrateTimer } from '../load/calibrate.js';
import { selfTest } from '../load/driver.js';

export const LB_PORT = 4310;

export const lab = {
  budget: null,
  cpu: null,        // calibrated work unit
  timer: null,      // measured timer floor
  ceiling: null,    // load driver's own maximum
  lb: null,
  preflightAt: null
};

export const lbUrl = (path = '/work') => 'http://127.0.0.1:' + LB_PORT + path;

export async function init() {
  lab.budget = budget();
  lab.lb = createBalancer({ port: LB_PORT, policy: 'round-robin' });
  await lab.lb.listen();
  lab.lb.startHealth();
}

// Everything the lab needs to know about the machine before it measures
// anything on it. Runs once at startup and again whenever Tab 1 asks, because
// a laptop that has been busy for an hour is not the machine that booted.
export async function preflight() {
  lab.budget = budget();
  lab.cpu = calibrateCpu(15);
  lab.timer = await calibrateTimer();

  // Needs one instance to measure against.
  const had = sup.list().length;
  if (!had) await sup.scale(1, { workers: 1, rounds: lab.cpu.rounds });
  syncBalancer();
  const first = sup.list()[0];
  lab.ceiling = await selfTest('http://127.0.0.1:' + first.port + '/ping', { durationMs: 2500 });

  lab.preflightAt = Date.now();
  return snapshot();
}

// The balancer's view of the world has to be told when the fleet changes. In
// production this is service discovery; here it is one function call, and
// keeping it explicit is the point - a balancer pointing at instances that no
// longer exist is a real and common outage.
export function syncBalancer() {
  lab.lb.setBackends(sup.list().map((i) => ({ id: i.id, port: i.port })));
}

export async function ensureFleet(size, workers = 1) {
  const out = await sup.scale(size, { workers, rounds: lab.cpu?.rounds });
  syncBalancer();
  return out;
}

export function snapshot() {
  return {
    budget: lab.budget,
    cpu: lab.cpu,
    timer: lab.timer,
    ceiling: lab.ceiling,
    preflightAt: lab.preflightAt,
    fleet: sup.list(),
    balancer: lab.lb ? lab.lb.snapshot() : null
  };
}

// The work URL every tab drives, with the calibrated round count baked in so
// that "one unit of work" means the same thing everywhere.
export function workPath({ mode = 'io:query', downstreamMs, key } = {}) {
  const p = new URLSearchParams({ mode });
  p.set('rounds', String(lab.cpu?.rounds ?? 12000));
  // Never ask for a wait the platform cannot deliver. On Windows anything under
  // about 15 ms is rounded up unpredictably, so the lab clamps to the floor it
  // measured rather than quietly returning a different experiment.
  const floor = lab.timer?.floorMs ?? 5;
  if (downstreamMs !== undefined) p.set('downstreamMs', String(Math.max(downstreamMs, downstreamMs === 0 ? 0 : floor)));
  if (key) p.set('key', key);
  return '/work?' + p.toString();
}

export { sup };
