/* Scaling & Load Balancing Lab - the whole front end.
   Classic script, no modules, no build step, no framework. Same five helpers as
   the other two courses, so if you have read one lab UI you have read this one. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const num = (n) => Number(n).toLocaleString('en-US');
const ms  = (n) => (n == null ? '—' : Number(n).toFixed(n < 10 ? 2 : 1) + ' ms');
const pct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return res.json();
};

const metric = (label, value, cls = '') =>
  `<div class="metric ${cls}"><b>${value}</b><span>${label}</span></div>`;

const notice = (text, cls = '') => `<div class="notice ${cls}">${text}</div>`;
const readme = (text) => `<div class="readme">${esc(text)}</div>`;

// Every run button behaves the same: disable, show a spinner, restore whatever
// label it started with. Doing this in one place means no tab can forget.
async function run(btn, fn) {
  const el = typeof btn === 'string' ? $(btn) : btn;
  const label = el.textContent;
  el.disabled = true;
  el.innerHTML = '<span class="spin"></span>running…';
  try { return await fn(); }
  finally { el.disabled = false; el.textContent = label; }
}

const fail = (out, r) => { $(out).innerHTML = notice('<b>Failed.</b> ' + esc(r.error || 'unknown error'), 'bad'); };

/* ==================================================== tabs + liveness ======= */

$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === b.dataset.tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (b.dataset.tab === 'health') refreshHealth();
  if (b.dataset.tab === 'nginx') loadNginx();
});

let STATE = null;

async function loadState() {
  try {
    const s = await api('/api/state');
    STATE = s;
    $('#live').classList.add('live');
    const b = s.budget;
    $('#machine').textContent =
      `${b.cores} cores` +
      (b.takenByWsl ? `, ${b.takenByWsl} to WSL2` : '') +
      ` · fleet budget ${b.fleet}` +
      (s.cpu ? ` · work unit ${s.cpu.measuredMs} ms` : ' · not calibrated');
    $('#vSweep').textContent = 'sweep: ' + b.sweep.join(', ');
    $('#hSweep').textContent = 'sweep: ' + b.sweep.join(', ');
    return s;
  } catch {
    $('#live').classList.remove('live');
    $('#machine').textContent = 'lab unreachable';
  }
}

/* ==================================================== 1. CAPACITY ========== */

function preflightCard(s) {
  const b = s.budget, c = s.cpu, t = s.timer, ceil = s.ceiling;
  let html = '<div class="metrics">' +
    metric('logical cores', b.cores) +
    metric('fleet budget', b.fleet, b.smallMachine ? 'warn' : 'good') +
    (c ? metric('work unit', c.measuredMs + ' ms', c.noisy ? 'warn' : '') : '') +
    (t ? metric('timer floor', t.floorMs + ' ms', t.coarse ? 'warn' : 'good') : '') +
    (ceil ? metric('driver ceiling', num(Math.round(ceil.ceilingRps)) + ' rps', 'idx') : '') +
    '</div>';

  html += notice('<b>Cores.</b> ' + esc(b.readMe), b.smallMachine ? 'warn' : '');
  if (b.wsl && b.wsl.note) html += notice('<b>WSL2.</b> ' + esc(b.wsl.note));
  if (c) html += notice('<b>Work unit.</b> ' + esc(c.note), c.noisy ? 'warn' : '');
  if (t) html += notice('<b>Timer.</b> ' + esc(t.note), t.coarse ? 'warn' : '');
  if (ceil) html += notice('<b>Instrument.</b> ' + esc(ceil.note));
  return html;
}

$('#pfRun').onclick = () => run('#pfRun', async () => {
  $('#pfOut').innerHTML = notice('Calibrating…');
  const s = await api('/api/preflight', {});
  if (s.ok === false) return fail('#pfOut', s);
  STATE = s;
  await loadState();
  $('#pfOut').innerHTML = preflightCard(s);
});

// A small SVG line chart. Two series, an optional ideal line, no dependency.
function lineChart(points, { x, a, b, aLabel, bLabel, ideal }) {
  const W = 720, H = 240, P = 42;
  const xs = points.map(p => p[x]);
  const as = points.map(p => p[a]);
  const bs = b ? points.map(p => p[b]) : [];
  const maxX = Math.max(...xs), minX = Math.min(...xs);
  const maxA = Math.max(...as, ...(ideal ? as.map((_, i) => as[0] * xs[i]) : [])) * 1.08 || 1;
  const maxB = bs.length ? Math.max(...bs) * 1.08 : 1;

  const px = (v) => P + ((v - minX) / Math.max(maxX - minX, 1)) * (W - P * 2);
  const pa = (v) => H - P + 8 - (v / maxA) * (H - P - 24);
  const pb = (v) => H - P + 8 - (v / maxB) * (H - P - 24);

  const path = (vals, scale) => vals.map((v, i) => (i ? 'L' : 'M') + px(xs[i]) + ' ' + scale(v)).join(' ');
  const idealPath = ideal ? xs.map((v, i) => (i ? 'L' : 'M') + px(v) + ' ' + pa(as[0] * v)).join(' ') : null;

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = H - P + 8 - (i / 4) * (H - P - 24);
    g += `<line class="grid-l" x1="${P}" y1="${y}" x2="${W - P}" y2="${y}"/>` +
         `<text class="lbl" x="6" y="${y + 3}">${Math.round((maxA * i) / 4)}</text>`;
  }
  const ticks = xs.map(v => `<text class="lbl" x="${px(v)}" y="${H - 16}" text-anchor="middle">${v}</text>`).join('');

  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${g}
      <line class="axis" x1="${P}" y1="${H - P + 8}" x2="${W - P}" y2="${H - P + 8}"/>
      ${idealPath ? `<path class="ideal" d="${idealPath}"/>` : ''}
      <path class="line-a" d="${path(as, pa)}"/>
      ${bs.length ? `<path class="line-b" d="${path(bs, pb)}"/>` : ''}
      ${xs.map((v, i) => `<circle class="dot-a" cx="${px(v)}" cy="${pa(as[i])}" r="3"/>`).join('')}
      ${bs.length ? xs.map((v, i) => `<circle class="dot-b" cx="${px(v)}" cy="${pb(bs[i])}" r="3"/>`).join('') : ''}
      ${ticks}
    </svg>
    <div class="legend">
      <span><i style="background:var(--ok)"></i>${esc(aLabel)}</span>
      ${bs.length ? `<span><i style="background:var(--idx)"></i>${esc(bLabel)}</span>` : ''}
      ${ideal ? '<span><i style="background:var(--faint)"></i>perfect scaling</span>' : ''}
    </div></div>`;
}

$('#rampRun').onclick = () => run('#rampRun', async () => {
  $('#rampOut').innerHTML = notice('Ramping concurrency…');
  const r = await api('/api/capacity/ramp', { mode: $('#rampMode').value });
  if (r.ok === false) return fail('#rampOut', r);

  const rows = r.points.map(p => `<tr>
    <td class="mono">${p.concurrency}</td>
    <td class="mono">${p.rps}</td>
    <td class="mono">${ms(p.p50)}</td>
    <td class="mono">${ms(p.p95)}</td>
    <td class="mono">${ms(p.p99)}</td>
    <td>${p.instrument.limited ? '<span class="pill seq">instrument-limited</span>' : ''}</td></tr>`).join('');

  $('#rampOut').innerHTML =
    '<div class="metrics">' +
      metric('peak', r.peakRps + ' rps', 'good') +
      metric('knee at', 'c=' + r.knee.concurrency, 'idx') +
      metric('p99 at knee', ms(r.knee.p99)) +
      metric('work unit', r.workUnitMs + ' ms') +
    '</div>' +
    lineChart(r.points, { x: 'concurrency', a: 'rps', b: 'p99', aLabel: 'throughput (rps)', bLabel: 'p99 latency' }) +
    '<table class="grid"><tr><th>concurrency</th><th>rps</th><th>p50</th><th>p95</th><th>p99</th><th></th></tr>' + rows + '</table>' +
    readme(r.readMe);
});

$('#coRun').onclick = () => run('#coRun', async () => {
  $('#coOut').innerHTML = notice('Running both loops…');
  const r = await api('/api/capacity/omission', { mode: 'cpu' });
  if (r.ok === false) return fail('#coOut', r);
  $('#coOut').innerHTML =
    `<table class="grid">
      <tr><th></th><th>rps</th><th>p50</th><th>p99</th></tr>
      <tr><td>closed loop</td><td class="mono">${r.closed.rps}</td><td class="mono">${ms(r.closed.p50)}</td><td class="mono">${ms(r.closed.p99)}</td></tr>
      <tr><td>open loop</td><td class="mono">${r.open.rps}</td><td class="mono">${ms(r.open.p50)}</td><td class="mono"><b>${ms(r.open.p99)}</b></td></tr>
    </table>` +
    (r.ratio ? '<div class="metrics">' + metric('p99 understated by', r.ratio + '×', 'bad') + '</div>' : '') +
    readme(r.readMe);
});

$('#noiseRun').onclick = () => run('#noiseRun', async () => {
  $('#noiseOut').innerHTML = notice('Repeating the same run…');
  const r = await api('/api/capacity/noise', {});
  if (r.ok === false) return fail('#noiseOut', r);
  $('#noiseOut').innerHTML =
    '<table class="grid"><tr><th>run</th><th>rps</th><th>p50</th><th>p99</th></tr>' +
    r.runs.map(x => `<tr><td class="mono">${x.run}</td><td class="mono">${x.rps}</td><td class="mono">${ms(x.p50)}</td><td class="mono">${ms(x.p99)}</td></tr>`).join('') +
    '</table>' +
    '<div class="metrics">' +
      metric('rps spread', pct(r.rpsSpreadPct), r.trustworthy ? 'good' : 'warn') +
      metric('p99 spread', pct(r.p99SpreadPct), r.trustworthy ? 'good' : 'warn') +
    '</div>' + readme(r.readMe);
});

/* ============================================ 2 + 3. VERTICAL / HORIZONTAL == */

function sweepView(r) {
  const rows = r.points.map(p => `<tr>
    <td class="mono">${p.n}</td>
    <td class="mono">${p.rps}</td>
    <td class="mono">${p.speedup}×</td>
    <td class="mono">${Math.round(p.efficiency * 100)}%</td>
    <td class="mono">${ms(p.p50)}</td>
    <td class="mono">${ms(p.p99)}</td>
    <td>${p.instrument.limited ? '<span class="pill seq">instrument</span>' : ''}</td></tr>`).join('');

  return '<div class="metrics">' +
      metric('best', r.best.rps + ' rps', 'good') +
      metric('speedup', r.best.speedup + '×', 'idx') +
      metric(r.axis === 'vertical' ? 'at workers' : 'at instances', r.best.workers || r.best.instances) +
      metric('fleet budget', r.fleetBudget) +
    '</div>' +
    (r.thermal.drifted ? notice('<b>Thermal drift.</b> ' + esc(r.thermal.note), 'warn')
                       : notice('<b>Thermal check.</b> ' + esc(r.thermal.note))) +
    lineChart(r.points, { x: 'n', a: 'rps', b: 'p99', aLabel: 'throughput (rps)', bLabel: 'p99 latency', ideal: true }) +
    '<table class="grid"><tr><th>' + (r.axis === 'vertical' ? 'workers' : 'instances') +
    '</th><th>rps</th><th>speedup</th><th>efficiency</th><th>p50</th><th>p99</th><th></th></tr>' + rows + '</table>' +
    readme(r.readMe);
}

$('#vRun').onclick = () => run('#vRun', async () => {
  $('#vOut').innerHTML = notice('Sweeping worker counts — this restarts the instance at each point…');
  const r = await api('/api/scaling/vertical', { mode: $('#vMode').value });
  if (r.ok === false) return fail('#vOut', r);
  $('#vOut').innerHTML = sweepView(r);
});

$('#hRun').onclick = () => run('#hRun', async () => {
  $('#hOut').innerHTML = notice('Sweeping instance counts…');
  const r = await api('/api/scaling/horizontal', { mode: $('#hMode').value });
  if (r.ok === false) return fail('#hOut', r);
  $('#hOut').innerHTML = sweepView(r);
});

$('#ctlRun').onclick = () => run('#ctlRun', async () => {
  $('#ctlOut').innerHTML = notice('Running four measurements…');
  const r = await api('/api/scaling/control', { instances: 4 });
  if (r.ok === false) return fail('#ctlOut', r);

  const row = (mode) => {
    const d = r.results[mode];
    const flat = d.ratio !== null && d.ratio < 1.5;
    return `<tr>
      <td class="mono">${esc(mode)}</td>
      <td class="mono">${d.many.rps}</td>
      <td class="mono">${d.one.rps}</td>
      <td class="mono"><span class="pill ${flat ? 'seq' : 'ok'}">${d.ratio}×</span></td>
      <td>${flat ? 'adding instances bought nothing' : 'instance count is the variable'}</td></tr>`;
  };

  $('#ctlOut').innerHTML =
    `<table class="grid">
      <tr><th>work</th><th>${r.instances} instances</th><th>1 instance</th><th>ratio</th><th></th></tr>
      ${row('io:query')}${row('cpu')}
    </table>` + readme(r.readMe);
});

/* ==================================================== 4. BALANCER ========== */

function distBars(results, key) {
  const worst = Math.max(...results.map(x => x[key] || 0)) || 1;
  return '<div class="bars">' + results.map(x => `
    <div class="bar-row">
      <span>${esc(x.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${((x[key] || 0) / worst * 100).toFixed(1)}%;background:${x.label === 'round-robin' ? 'var(--seq)' : 'var(--ok)'}"></div></div>
      <span class="bar-num">${x[key]} ${key === 'rps' ? 'rps' : ''}</span>
    </div>`).join('') + '</div>';
}

$('#bRun').onclick = () => run('#bRun', async () => {
  $('#bOut').innerHTML = notice('Running each policy against the same fleet…');
  const r = await api('/api/balancer/compare', { mode: $('#bMode').value, degrade: $('#bDegrade').value, instances: 4 });
  if (r.ok === false) return fail('#bOut', r);

  const rows = r.results.map(x => `<tr>
    <td>${esc(x.label)}</td>
    <td class="mono">${x.rps}</td>
    <td class="mono">${ms(x.p50)}</td>
    <td class="mono">${ms(x.p99)}</td>
    <td class="mono">${pct(x.skewPct)}</td>
    <td class="mono">${r.degraded ? pct(x.toDegraded) : '—'}</td>
    <td>${x.distribution.map(d => `<span class="pill ${d.id === r.degraded ? 'bad' : ''}">${esc(d.id)} ${d.pct}%</span>`).join(' ')}</td>
  </tr>`).join('');

  $('#bOut').innerHTML =
    notice('<b>Scenario.</b> ' + esc(r.scenario)) +
    distBars(r.results, 'rps') +
    '<table class="grid"><tr><th>policy</th><th>rps</th><th>p50</th><th>p99</th><th>skew</th><th>to degraded</th><th>distribution</th></tr>' + rows + '</table>' +
    readme(r.readMe);
});

$('#zRun').onclick = () => run('#zRun', async () => {
  $('#zOut').innerHTML = notice('Running with health checking off…');
  const r = await api('/api/balancer/zombie', { instances: 4 });
  if (r.ok === false) return fail('#zOut', r);
  const rows = r.results.map(x => `<tr>
    <td>${esc(x.label)}</td>
    <td class="mono">${x.rps}</td>
    <td class="mono">${pct(x.errorRatePct)}</td>
    <td class="mono"><span class="pill ${x.toZombie > r.fairSharePct * 1.3 ? 'bad' : 'ok'}">${pct(x.toZombie)}</span></td>
  </tr>`).join('');
  $('#zOut').innerHTML =
    notice('<b>Scenario.</b> ' + esc(r.scenario) + ' An even split would be ' + pct(r.fairSharePct) + ' each.') +
    '<table class="grid"><tr><th>policy</th><th>rps</th><th>errors</th><th>into the black hole</th></tr>' + rows + '</table>' +
    readme(r.readMe);
});

(async () => {
  const r = await api('/api/balancer/policies');
  $('#polTable').innerHTML =
    '<tr><th>policy</th><th>buys</th><th>costs</th></tr>' +
    r.policies.map(p => `<tr><td class="mono">${esc(p.id)}${p.sticky ? ' <span class="pill idx">sticky</span>' : ''}</td><td>${esc(p.buys)}</td><td>${esc(p.costs)}</td></tr>`).join('');
})();

/* ==================================================== 5. STATELESS ========= */

$('#s1').onclick = () => run('#s1', async () => {
  $('#sOut').innerHTML = notice('Measuring…');
  const r = await api('/api/stateless/inmemory', { instances: 4 });
  if (r.ok === false) return fail('#sOut', r);
  $('#sOut').innerHTML =
    '<div class="metrics">' +
      metric('wrong instance', pct(r.wrongInstancePct), 'bad') +
      metric('theoretical (n-1)/n', pct(r.theoretical)) +
      metric('instances', r.instances) +
    '</div>' + readme(r.readMe);
});

$('#s2').onclick = () => run('#s2', async () => {
  $('#sOut').innerHTML = notice('Hashing 20,000 keys…');
  const r = await api('/api/stateless/sticky', { instances: 4 });
  if (r.ok === false) return fail('#sOut', r);
  $('#sOut').innerHTML =
    '<div class="metrics">' +
      metric('wrong instance', '0%', 'good') +
      metric('load skew', pct(r.skewPct), 'warn') +
      metric('modulo reshuffle', pct(r.reshuffle.moduloPct), 'bad') +
      metric('consistent ring', pct(r.reshuffle.consistentPct), 'good') +
      metric('ideal', pct(r.reshuffle.idealPct)) +
    '</div>' +
    '<table class="grid"><tr><th>instance</th><th>keys</th><th>share</th></tr>' +
    r.distribution.map(d => `<tr><td class="mono">${esc(d.id)}</td><td class="mono">${num(d.n)}</td><td class="mono">${pct(d.pct)}</td></tr>`).join('') +
    '</table>' + readme(r.readMe);
});

$('#s3').onclick = () => run('#s3', async () => {
  $('#sOut').innerHTML = notice('Measuring the session round trip…');
  const r = await api('/api/stateless/shared', { instances: 4 });
  if (r.ok === false) return fail('#sOut', r);
  $('#sOut').innerHTML =
    '<div class="metrics">' +
      metric('wrong instance', '0%', 'good') +
      metric('session read+write', ms(r.sessionRoundTripP50), 'warn') +
      metric('p99', ms(r.sessionRoundTripP99)) +
      metric('baseline p50', ms(r.baselineP50)) +
    '</div>' + readme(r.readMe);
});

/* ==================================================== 6. HEALTH ============ */

const FAULTS = ['healthy', 'dead', 'hung', 'slow', 'error', 'unready', 'deep-fail', 'zombie', 'flapping'];

function fleetBoard(health) {
  if (!health || !health.nodes.length) return notice('No fleet running. Press <b>Fleet of 4</b>.');
  return '<div class="fleet">' + health.nodes.map(n => `
    <div class="node ${esc(n.status)}">
      ${n.weight > 0 && n.weight < 1 ? `<span class="w">w ${n.weight}</span>` : ''}
      <b>${esc(n.id)}</b>
      <span class="port">:${n.port}</span>
      <div class="st"><span class="pill ${n.status === 'healthy' ? 'ok' : (n.status === 'probing' ? 'seq' : 'bad')}">${esc(n.status)}</span></div>
      <select data-node="${esc(n.id)}">
        ${FAULTS.map(f => `<option value="${f}">${f}</option>`).join('')}
      </select>
    </div>`).join('') + '</div>';
}

function eventStream(health) {
  if (!health || !health.events.length) return '<div class="events"><div>no events yet</div></div>';
  return '<div class="events">' + health.events.slice().reverse().map(e => {
    const t = new Date(e.at).toISOString().slice(11, 23);
    return `<div class="${esc(e.type)}">${t}  ${esc(e.id)}  ${esc(e.type)}  ${esc(e.detail)}</div>`;
  }).join('') + '</div>';
}

async function refreshHealth() {
  const s = await api('/api/state');
  STATE = s;
  const h = s.balancer && s.balancer.health;
  $('#hFleet').outerHTML = fleetBoard(h).replace('<div class="fleet">', '<div class="fleet" id="hFleet">');
  $('#hEvents').outerHTML = eventStream(h).replace('<div class="events">', '<div class="events" id="hEvents">');
  if (h) $('#hPath').value = h.config.path;
  bindNodes();
}

function bindNodes() {
  $$('#hFleet select').forEach(sel => sel.onchange = async () => {
    const id = sel.dataset.node, state = sel.value;
    if (state === 'healthy') await api('/api/health/revive', { id });
    else await api('/api/health/inject', { id, state });
    setTimeout(refreshHealth, 400);
  });
}

$('#hFleet4').onclick = () => run('#hFleet4', async () => {
  await api('/api/fleet/scale', { size: 4, workers: 1 });
  await refreshHealth();
});

$('#hPath').onchange = async () => {
  const r = await api('/api/health/checkpath', { path: $('#hPath').value });
  $('#hPathNote').textContent = r.note || '';
};

$('#dRun').onclick = () => run('#dRun', async () => {
  $('#dOut').innerHTML = notice('Breaking an instance and timing the ejection…');
  const r = await api('/api/health/detect', { fault: $('#dFault').value, instances: 4 });
  if (r.ok === false) return fail('#dOut', r);
  $('#dOut').innerHTML =
    '<div class="metrics">' +
      metric('detected in', r.ejectedMs == null ? 'never' : r.ejectedMs + ' ms', r.ejectedMs == null ? 'bad' : 'good') +
      metric('theoretical floor', r.theoreticalMs + ' ms') +
      metric('probe said', r.lastError || '—') +
    '</div>' + readme(r.readMe) +
    notice('<b>This fault teaches.</b> ' + esc(r.teaches || ''));
  refreshHealth();
});

$('#cascRun').onclick = () => run('#cascRun', async () => {
  $('#cascOut').innerHTML = notice('Breaking the dependency for every instance…');
  const r = await api('/api/health/cascade', { instances: 4 });
  if (r.ok === false) return fail('#cascOut', r);
  $('#cascOut').innerHTML =
    '<table class="grid"><tr><th>phase</th><th>healthy</th><th>panic</th></tr>' +
    r.phases.map(p => `<tr><td>${esc(p.phase)}<div class="hint">${esc(p.note)}</div></td>
      <td class="mono"><span class="pill ${p.healthy === p.total ? 'ok' : 'bad'}">${p.healthy}/${p.total}</span></td>
      <td class="mono">${p.panic ? '<span class="pill seq">panic</span>' : '—'}</td></tr>`).join('') +
    '</table>' + readme(r.readMe);
  refreshHealth();
});

(async () => {
  const r = await api('/api/health/faults');
  $('#faultTable').innerHTML =
    '<tr><th>fault</th><th>what it teaches</th></tr>' +
    r.faults.map(f => `<tr><td class="mono">${esc(f.id)}</td><td>${esc(f.teaches)}</td></tr>`).join('');
})();

/* ==================================================== 7. FAILURE =========== */

$('#fRun').onclick = () => run('#fRun', async () => {
  $('#fOut').innerHTML = notice('Six windows of constant-rate traffic. This takes about fifteen seconds…');
  const r = await api('/api/failure/outage', {
    fault: $('#fFault').value,
    ratePerSec: Number($('#fRate').value),
    retry: $('#fRetry').value === 'on',
    instances: 4
  });
  if (r.ok === false) return fail('#fOut', r);

  const worstP99 = Math.max(...r.timeline.map(t => t.p99)) || 1;
  const tl = r.timeline.map(t => `
    <div class="tl-row">
      <span class="tl-num">${t.atSec}s</span>
      <div class="tl-bar"><div class="tl-fill ${t.errorRatePct > 1 ? 'err' : ''}" style="width:${Math.min(100, (t.p99 / worstP99) * 100).toFixed(1)}%"></div></div>
      <span class="tl-num">${pct(t.errorRatePct)} err</span>
      <span class="tl-ev">${esc(t.event || (t.healthy + '/' + t.total))}</span>
    </div>`).join('');

  $('#fOut').innerHTML =
    '<div class="metrics">' +
      metric('worst window', pct(r.worstWindow.errorRatePct), 'bad') +
      metric('worst p99', ms(r.worstWindow.p99), 'warn') +
      metric('mean errors', pct(r.meanErrorPct)) +
      metric('offered', r.ratePerSec + ' rps') +
    '</div>' +
    '<div class="timeline">' + tl + '</div>' +
    '<table class="grid"><tr><th>at</th><th>rps</th><th>errors</th><th>p50</th><th>p99</th><th>healthy</th><th>event</th></tr>' +
    r.timeline.map(t => `<tr><td class="mono">${t.atSec}s</td><td class="mono">${t.rps}</td>
      <td class="mono">${pct(t.errorRatePct)}</td><td class="mono">${ms(t.p50)}</td><td class="mono">${ms(t.p99)}</td>
      <td class="mono">${t.healthy}/${t.total}</td><td class="mono">${esc(t.event)}</td></tr>`).join('') +
    '</table>' + readme(r.readMe);
});

/* ==================================================== 8. THE REAL THING ==== */

let nginxLoaded = false;
async function loadNginx() {
  const a = await api('/api/nginx/available');
  $('#ngStatus').innerHTML = a.up
    ? notice('<b>nginx is up</b> on port ' + a.port + '.', '')
    : notice('<b>nginx is not running.</b> ' + esc(a.fix || '') + ' Everything below the mapping table needs it; the mapping itself does not.', 'warn');

  if (!nginxLoaded) {
    const m = await api('/api/nginx/mapping');
    $('#mapTable').innerHTML =
      '<tr><th>nginx directive</th><th>this lab</th><th>what it does</th></tr>' +
      m.mapping.map(x => `<tr><td class="mapfrom">${esc(x.nginx)}</td><td class="mapto">${esc(x.ours)}</td><td>${esc(x.does)}</td></tr>`).join('');
    nginxLoaded = true;
  }
}

$('#ngHop').onclick = () => run('#ngHop', async () => {
  $('#ngOut').innerHTML = notice('Measuring both paths…');
  const r = await api('/api/nginx/hop', {});
  if (r.ok === false) return fail('#ngOut', r);
  $('#ngOut').innerHTML =
    '<div class="metrics">' +
      metric('direct p50', ms(r.directP50), 'good') +
      metric('via nginx p50', ms(r.viaNginxP50), 'warn') +
      metric('the hop', '+' + r.addedMsP50 + ' ms', 'bad') +
    '</div>' + readme(r.readMe);
});

$('#ngBeh').onclick = () => run('#ngBeh', async () => {
  $('#ngOut').innerHTML = notice('Breaking an instance and watching both balancers…');
  const r = await api('/api/nginx/behaviour', { fault: 'dead' });
  if (r.ok === false) return fail('#ngOut', r);
  $('#ngOut').innerHTML =
    `<table class="grid">
      <tr><th>balancer</th><th>noticed after</th><th>mechanism</th><th>requests failed</th></tr>
      <tr><td>this lab</td><td class="mono">${r.ours.detectedMs} ms</td><td class="hint">${esc(r.ours.mechanism)}</td><td class="mono">0 (probes, not users)</td></tr>
      <tr><td>nginx</td><td class="mono">${r.nginx.routedAwayMs == null ? '—' : r.nginx.routedAwayMs + ' ms'}</td><td class="hint">${esc(r.nginx.mechanism)}</td><td class="mono">${r.nginx.errorsSeen}</td></tr>
    </table>` + readme(r.readMe);
});

/* ==================================================== boot ================= */
loadState();
