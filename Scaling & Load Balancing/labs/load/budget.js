// How much of this machine is actually available to the fleet, and what sweep
// can honestly be run on it.
//
// This module exists because the first version of this lab hard-coded its
// sweeps to 1/2/4/8 workers. On a 32-thread machine every one of those points
// sits in the linear region, so the curve came out straight and the lesson
// would have concluded that vertical scaling is linear. It is not. A sweep that
// never reaches saturation does not measure a ceiling - it just fails to find
// one, which is a different thing and reads identically on a chart.
//
// So: nothing here is a constant. Everything is derived from the machine the
// lab is presently running on, and printed before any measurement is taken.
import os from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// WSL2 - and therefore Docker Desktop, and therefore Postgres - takes its share
// of this machine before the fleet gets any. On a default install that share is
// about half the RAM and all the cores; if the user has a .wslconfig it is
// whatever they wrote there. Either way the fleet does not get the whole box,
// and a lab that assumes it does will attribute WSL's contention to its own
// scaling curve.
export function wslAllocation() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return { found: false };
  const path = join(home, '.wslconfig');
  if (!existsSync(path)) {
    return {
      found: false,
      note: 'No .wslconfig: WSL2 defaults to roughly half this machine\'s RAM and all of its cores.'
    };
  }
  try {
    const text = readFileSync(path, 'utf8');
    // Parsed by hand rather than with a regex: .wslconfig is INI-ish, and a
    // line-by-line reader is easier to be sure about than an escaped pattern.
    const grab = (key) => {
      for (const line of text.split(String.fromCharCode(10))) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith(";") || t.startsWith("[")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        if (t.slice(0, eq).trim().toLowerCase() === key) return t.slice(eq + 1).trim();
      }
      return null;
    };
    const processors = grab('processors');
    const memory = grab('memory');
    return {
      found: true,
      path,
      processors: processors ? Number(processors) : null,
      memory,
      note: `WSL2 is configured for ${processors || 'all'} processors and ${memory || 'default'} of RAM.`
    };
  } catch {
    return { found: false };
  }
}

// Powers of two miss the knee. On a budget of 26 the points 1,2,4,8,16 jump
// straight past the interesting region between 8 and 16, so the curve looks
// like two straight lines meeting at a corner that is an artifact of the
// sampling rather than of the machine. Midpoints are what make a knee legible.
export function sweep(budget) {
  const points = new Set([1]);
  for (let p = 2; p <= budget; p *= 2) {
    points.add(p);
    const mid = Math.floor(p * 1.5);
    if (mid <= budget) points.add(mid);
  }
  points.add(budget);
  return [...points].filter((n) => n >= 1 && n <= budget).sort((a, b) => a - b);
}

export function budget() {
  const cores = os.cpus().length;
  const wsl = wslAllocation();

  // A configured WSL processor count is a claim on this machine that Windows
  // will honour under contention, so it is subtracted rather than wished away.
  const takenByWsl = wsl.processors && wsl.processors < cores ? wsl.processors : 0;
  const usable = Math.max(2, cores - takenByWsl);

  // The measuring instruments need cores of their own. If the load driver is
  // descheduled at the exact moment the fleet saturates, the latency it records
  // is its own starvation - and that lands precisely on the data point the
  // lesson is about. Reserving capacity for the instruments is not overhead,
  // it IS the measurement.
  //
  // Derived from what is USABLE, not from the nominal core count: on a machine
  // where WSL has already taken most of the cores, reserving four of the few
  // that remain would leave nothing to measure.
  const forDriver = Math.min(4, Math.max(1, Math.floor(usable / 4)));
  const forLb = 1;
  const forOs = 1;
  const fleet = Math.max(1, usable - forDriver - forLb - forOs);

  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;

  return {
    cores,
    wsl,
    takenByWsl,
    usable,
    reserved: { driver: forDriver, balancer: forLb, os: forOs },
    fleet,
    sweep: sweep(fleet),
    memory: {
      totalGb: Math.round(totalGb * 10) / 10,
      freeGb: Math.round(freeGb * 10) / 10,
      // Each instance is a trivial server; 128 MB is generous and turns a leak
      // into a crash you can see rather than a machine that slowly starts
      // paging. Paging is the dangerous one: it corrupts the tail latency the
      // whole chapter is built on, and it looks exactly like a scaling limit.
      perInstanceMb: 128,
      projectedFleetMb: fleet * 128
    },
    // Below this the curves have too few points to show a knee. Saying so is
    // better than drawing two points and calling it a curve.
    smallMachine: fleet < 4,
    readMe: fleet < 4
      ? `Only ${fleet} core(s) are available to the fleet, so the Vertical and Horizontal curves will have too few points to show a knee. The Balancer, Stateless, Health and Failure tabs do not depend on core count and work fully. Reference numbers from a larger run are in the chapter README.`
      : `The fleet may use ${fleet} of ${cores} logical cores. ${forDriver} are reserved for the load driver, ${forLb} for the balancer and ${forOs} for the OS${takenByWsl ? `, and ${takenByWsl} are claimed by WSL2 for Docker` : ''}. Every sweep below is generated from that budget, not hard-coded.`
  };
}
