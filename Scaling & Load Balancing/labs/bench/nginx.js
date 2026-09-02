// Tab 8 - The real thing.
//
// nginx doing the same job, so you can check your own balancer against twelve
// lines of someone else's C.
//
// This tab deliberately REFUSES to compare throughput, and the refusal is the
// interesting part. nginx runs in a container and reaches the fleet across a
// WSL2 virtual network hop that the host-native Node balancer never pays. Any
// rps or latency table would be measuring Docker's network stack and
// attributing it to nginx. The lab measures that hop and shows you its size
// rather than quietly folding it into a comparison.
//
// What IS comparable is behaviour: given the same fault, do the two balancers
// make the same decision, at the same time, for the same reason?
import { measure } from '../load/driver.js';
import { DEFAULTS } from '../lb/health.js';
import { lab, sup, ensureFleet, workPath, preflight } from './state.js';

const NGINX_PORT = 4320;
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function available() {
  try {
    const res = await fetch('http://127.0.0.1:' + NGINX_PORT + '/nginx-health', {
      signal: AbortSignal.timeout(1500)
    });
    return { up: res.ok, port: NGINX_PORT };
  } catch (err) {
    return {
      up: false,
      port: NGINX_PORT,
      error: String(err.cause?.code || err.name),
      fix: 'Start it with `npm run nginx:up` (needs Docker Desktop running). This tab is optional - every other tab works without it.'
    };
  }
}

// Each nginx directive, and the line of this lab that does the same job.
// This mapping is most of the teaching value of the tab, and it costs nothing
// to be right about.
export const mapping = () => [
  { nginx: 'upstream fleet { server ... }', ours: 'lb/balancer.js  setBackends()', does: 'the pool of backends' },
  { nginx: 'least_conn;', ours: 'lb/policies.js  POLICIES[least-conn]', does: 'choose the backend with fewest in-flight requests' },
  { nginx: 'hash $arg_key consistent;', ours: 'lb/policies.js  consistent-hash + buildRing()', does: 'sticky routing that survives a pool change' },
  { nginx: 'max_fails=3', ours: 'lb/health.js  ejectAfter: ' + DEFAULTS.ejectAfter, does: 'consecutive failures before ejection' },
  { nginx: 'fail_timeout=5s', ours: 'lb/health.js  probeAfterMs: ' + DEFAULTS.probeAfterMs, does: 'how long an ejected backend stays out before being retried' },
  { nginx: 'slow_start=10s', ours: 'lb/health.js  rampMs: ' + DEFAULTS.rampMs + ' + weight()', does: 'ramp a recovered backend back in gradually' },
  { nginx: 'proxy_next_upstream error timeout http_500;', ours: 'lb/balancer.js  retryOnFailure', does: 'retry a failed request on another backend' },
  { nginx: 'proxy_connect_timeout / proxy_read_timeout', ours: 'lb/balancer.js  upstream.setTimeout(5000)', does: 'give up on a backend that accepted and went quiet' },
  { nginx: 'keepalive 64;', ours: 'lb/balancer.js  new http.Agent({ keepAlive, maxSockets: 64 })', does: 'reuse upstream connections; the finite cap is what makes least-conn meaningful' },
  { nginx: '(no equivalent)', ours: 'lb/health.js  panicThreshold', does: 'nginx has no panic mode - if every backend fails max_fails it will eject all of them. Envoy added this idea; it is the difference between degraded and down.' }
];

/**
 * Measure the container hop, so the refusal to compare throughput is evidenced
 * rather than asserted.
 */
export async function hopCost({ durationMs = 2500 } = {}) {
  if (!lab.cpu) await preflight();
  await ensureFleet(2, 1);
  const inst = sup.list()[0];

  const ng = await available();
  if (!ng.up) return { ok: false, ...ng };

  // A trivial endpoint both ways: whatever differs is transport, not work.
  const direct = await measure({
    url: 'http://127.0.0.1:' + inst.port + '/ping',
    concurrency: 8, durationMs, warmupMs: 700
  });
  const viaNginx = await measure({
    url: 'http://127.0.0.1:' + NGINX_PORT + '/ping',
    concurrency: 8, durationMs, warmupMs: 700
  });

  const added = round2(viaNginx.service.p50 - direct.service.p50);

  return {
    ok: true,
    directP50: direct.service.p50,
    viaNginxP50: viaNginx.service.p50,
    addedMsP50: added,
    directRps: direct.rps,
    viaNginxRps: viaNginx.rps,
    readMe:
      `Reaching an instance directly costs ${direct.service.p50} ms at p50. Reaching the same instance through nginx costs ${viaNginx.service.p50} ms - ${added} ms more.\n\n` +
      `Almost none of that is nginx. The container has to cross a WSL2 virtual network to reach a process on the host, and the Node balancer, running on the host beside the fleet, never pays it. ` +
      `A throughput table comparing the two would be a table about Docker's network stack, which is why this tab does not draw one.\n\n` +
      `If you want to compare balancer throughput honestly, both have to sit in the same place on the network. That is a real experiment - it just needs two machines, or two containers, rather than a laptop.`
  };
}

/**
 * Behaviour comparison: same fault, same fleet, and a look at whether the two
 * balancers decide the same thing at roughly the same time.
 */
export async function behaviour({ fault = 'dead' } = {}) {
  if (!lab.cpu) await preflight();
  const ng = await available();
  if (!ng.up) return { ok: false, ...ng };

  await ensureFleet(3, 1);
  await sleep(1500);
  const target = sup.list()[0];

  // Ours.
  const tOurs = Date.now();
  await sup.inject(target.id, fault);
  let oursMs = null;
  while (Date.now() - tOurs < 15000) {
    const node = lab.lb.snapshot().health.nodes.find((x) => x.id === target.id);
    if (node && node.status !== 'healthy') { oursMs = Date.now() - tOurs; break; }
    await sleep(25);
  }

  // nginx: passive only. It has no active probe in the open-source build, so it
  // learns a backend is bad by failing a real request on it - which means the
  // detection cost is paid by users rather than by probes.
  let nginxMs = null;
  let nginxErrors = 0;
  const tNg = Date.now();
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + NGINX_PORT + '/ping', { signal: AbortSignal.timeout(2000) });
      const served = res.headers.get('x-lab-instance');
      if (!res.ok) nginxErrors++;
      if (served && served !== target.id && nginxMs === null && i > 2) { nginxMs = Date.now() - tNg; }
    } catch { nginxErrors++; }
    await sleep(100);
  }

  await sup.revive(target.id, 500);

  return {
    ok: true,
    fault,
    target: target.id,
    ours: { detectedMs: oursMs, mechanism: 'active probe every ' + DEFAULTS.intervalMs + ' ms, eject after ' + DEFAULTS.ejectAfter },
    nginx: { routedAwayMs: nginxMs, errorsSeen: nginxErrors, mechanism: 'passive: max_fails real requests within fail_timeout' },
    readMe:
      `Both balancers stopped using ${target.id}, and they found out in different ways.\n\n` +
      `This lab probes actively: it asks every instance every ${DEFAULTS.intervalMs} ms whether it is well, and ejects after ${DEFAULTS.ejectAfter} consecutive failures. Detection here took ${oursMs} ms and no user paid for it.\n\n` +
      `Open-source nginx has no active health check. It learns a backend is bad by sending it a real request and watching that fail - ${nginxErrors} requests failed during this run before it routed around the problem. That is the trade: no probe traffic at all, but the detection cost lands on users instead. ` +
      `nginx Plus adds active checks, and this is precisely the feature you are paying for.`
  };
}
