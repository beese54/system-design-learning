/* Data & Storage Lab - all interactivity, no dependencies.
   Every number rendered here came back from Postgres on this request. Nothing
   is cached, estimated or faked; if a panel says 9,093 blocks, the planner
   said 9,093 blocks. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const num = (n) => Number(n).toLocaleString('en-US');
const ms = (n) => (n == null ? '—' : Number(n).toFixed(n < 10 ? 2 : 1) + ' ms');

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return res.json();
};

const metric = (label, value, cls = '') => `<div class="metric ${cls}"><b>${value}</b><span>${label}</span></div>`;

/* ---------------------------------------------------------------- tabs -- */
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === b.dataset.tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (b.dataset.tab === 'indexes') loadIndexes();
  if (b.dataset.tab === 'locks') loadLocks();
  if (b.dataset.tab === 'pool') loadBudget();
});

/* -------------------------------------------------------------- health -- */
(async () => {
  try {
    const h = await api('/health');
    $('#live').classList.add('live');
    $('#dbInfo').textContent =
      'Postgres ' + h.db.version.split(' ')[0] + ' · ' + num(h.db.plays) + ' plays · pool ' + h.db.pool;
  } catch {
    $('#dbInfo').textContent = 'database unreachable — run `npm run db:up`';
  }
})();

/* ==================================================== 1. SCHEMA ========= */
(async () => {
  const s = await api('/api/schema');

  const totals = s.tables.reduce((acc, t) => ({ rows: acc.rows + Number(t.est_rows) }), { rows: 0 });
  $('#schemaMetrics').innerHTML =
    metric('tables', s.tables.length) +
    metric('rows (est.)', num(totals.rows)) +
    metric('constraints', s.constraints.length) +
    metric('on disk', s.tables.find(t => t.table_name === 'plays')?.total ?? '—', 'idx');

  // Which columns are keys, so the little PK/FK markers are accurate rather
  // than hard-coded.
  const pk = new Set(), fk = new Set();
  for (const c of s.constraints) {
    const cols = (c.definition.match(/\(([^)]+)\)/) || [, ''])[1].split(',').map(x => x.trim());
    for (const col of cols) {
      if (c.kind === 'PRIMARY KEY') pk.add(c.table_name + '.' + col);
      if (c.kind === 'FOREIGN KEY') fk.add(c.table_name + '.' + col);
    }
  }

  const byTable = {};
  for (const c of s.columns) (byTable[c.table_name] ||= []).push(c);
  const stats = Object.fromEntries(s.tables.map(t => [t.table_name, t]));

  $('#tableList').innerHTML = Object.entries(byTable)
    .sort((a, b) => Number(stats[b[0]]?.est_rows || 0) - Number(stats[a[0]]?.est_rows || 0))
    .map(([name, cols]) => {
      const st = stats[name];
      return `<div class="tbl">
        <header><b>${esc(name)}</b><span class="hint">${st ? num(st.est_rows) + ' rows' : 'view'}</span></header>
        <ul>${cols.map(c => {
          const key = name + '.' + c.column_name;
          const cls = pk.has(key) ? 'pk' : fk.has(key) ? 'fk' : '';
          return `<li class="${cls}"><span>${esc(c.column_name)}</span><span class="ty">${esc(c.data_type.replace('timestamp with time zone', 'timestamptz').replace('character', 'char'))}${c.is_nullable === 'NO' ? '' : ' ?'}</span></li>`;
        }).join('')}</ul>
        ${st ? `<footer>heap ${st.heap} · indexes ${st.indexes} · total ${st.total}</footer>` : ''}
      </div>`;
    }).join('');

  $('#consTable').innerHTML =
    '<tr><th>Table</th><th>Kind</th><th>Definition</th></tr>' +
    s.constraints.map(c => `<tr>
      <td class="mono">${esc(c.table_name)}</td>
      <td><span class="pill ${c.kind === 'FOREIGN KEY' ? 'idx' : 'ok'}">${esc(c.kind)}</span></td>
      <td class="mono">${esc(c.definition)}</td></tr>`).join('');
})();

/* ==================================================== 2. PLANS ========== */
let LIBRARY = [];
(async () => {
  LIBRARY = (await api('/api/queries')).library;
  $('#qPick').innerHTML = LIBRARY.map(q => `<option value="${q.id}">${esc(q.label)}</option>`).join('');
  showTeaches();
})();

const showTeaches = () => {
  const q = LIBRARY.find(x => x.id === $('#qPick').value);
  $('#qTeaches').textContent = q ? q.teaches : '';
};
$('#qPick').onchange = showTeaches;
$('#qLoad').onclick = () => {
  const q = LIBRARY.find(x => x.id === $('#qPick').value);
  if (q) { $('#sqlBox').value = q.sql; showTeaches(); }
};

$('#runPlan').onclick = async () => {
  const btn = $('#runPlan');
  btn.disabled = true; btn.textContent = 'running…';
  $('#planOut').textContent = 'running…';
  try {
    const r = await api('/api/explain', { sql: $('#sqlBox').value, analyze: $('#doAnalyze').checked });
    if (!r.ok) {
      $('#planMetrics').innerHTML = metric('error', '!', 'bad');
      $('#planOut').textContent = r.error + (r.position ? '\n\n(at character ' + r.position + ')' : '');
      return;
    }
    const s = r.summary;
    const worst = s.worstEstimate;
    $('#planMetrics').innerHTML =
      metric('execution', ms(r.executionMs), r.executionMs > 50 ? 'warn' : 'good') +
      metric('planning', ms(r.planningMs)) +
      metric('blocks read', num(s.buffers), s.buffers > 5000 ? 'bad' : '') +
      metric('rows removed', num(s.rowsRemoved), s.rowsRemoved > 100000 ? 'bad' : '') +
      metric('seq scans', s.seqScans, s.seqScans ? 'warn' : 'good') +
      metric('index scans', s.indexScans, s.indexScans ? 'idx' : '') +
      (worst ? metric('worst estimate', worst.ratio + '×', worst.ratio > 10 ? 'bad' : 'good') : '');
    $('#planOut').textContent = r.text;
  } finally {
    btn.disabled = false; btn.textContent = '▶ Explain and run';
  }
};

/* ==================================================== 3. INDEXES ======== */
const beforeAfter = {};   // id -> the probe taken before the index was added

async function loadIndexes() {
  const data = await api('/api/indexes');
  const present = data.candidates.filter(c => c.present).length;
  $('#idxSummary').textContent =
    present + ' of ' + data.candidates.length + ' lab indexes present · ' +
    data.existing.length + ' indexes on the database · ' +
    data.unused.length + ' never used since startup';

  $('#idxList').innerHTML = data.candidates.map(c => `
    <div class="idx-card ${c.present ? 'on' : ''}" data-id="${c.id}">
      <header>
        <div><b>${esc(c.label)}</b></div>
        <div class="idx-actions">
          <button class="alt" data-act="probe" data-id="${c.id}">Probe query</button>
          ${c.present
            ? `<button class="alt" data-act="drop" data-id="${c.id}">Drop</button>`
            : `<button class="go" data-act="create" data-id="${c.id}">Create</button>`}
        </div>
      </header>
      <p class="why"><b>Buys:</b> ${esc(c.buys)}</p>
      <p class="cost"><b>Costs:</b> ${esc(c.costs)}</p>
      <div class="ba" id="ba-${c.id}" style="display:none"></div>
    </div>`).join('');

  $$('#idxList button').forEach(b => b.onclick = () => idxAction(b.dataset.act, b.dataset.id));

  $('#idxTable').innerHTML =
    '<tr><th>Index</th><th>Table</th><th>Size</th><th>Scans</th><th>Definition</th></tr>' +
    data.existing.map(i => `<tr>
      <td class="mono">${esc(i.name)}</td>
      <td class="mono">${esc(i.table_name)}</td>
      <td class="mono">${esc(i.size)}</td>
      <td class="mono">${Number(i.scans) === 0 && !i.is_primary ? '<span class="pill bad">0</span>' : num(i.scans)}</td>
      <td class="mono sub">${esc(i.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON public\./, ''))}</td>
    </tr>`).join('');

  // Restore any before/after panels we already have results for.
  for (const [id, pair] of Object.entries(beforeAfter)) if (pair.after) renderBA(id);
}

async function idxAction(act, id) {
  const card = $(`.idx-card[data-id="${id}"]`);
  if (act === 'probe') {
    const r = await api('/api/indexes/probe', { id });
    if (!r.ok) return;
    const slot = r.present ? 'after' : 'before';
    (beforeAfter[id] ||= {})[slot] = r;
    renderBA(id);
    return;
  }
  if (act === 'create') {
    // Take a "before" reading automatically if the learner has not, so the
    // comparison is always available rather than depending on click order.
    if (!beforeAfter[id]?.before) {
      const b = await api('/api/indexes/probe', { id });
      if (b.ok) (beforeAfter[id] ||= {}).before = b;
    }
    card.style.opacity = '.5';
    const r = await api('/api/indexes/create', { id });
    card.style.opacity = '';
    if (r.ok) {
      const a = await api('/api/indexes/probe', { id });
      if (a.ok) (beforeAfter[id] ||= {}).after = a;
      beforeAfter[id].build = r;
    }
  }
  if (act === 'drop') {
    await api('/api/indexes/drop', { id });
    delete beforeAfter[id];
  }
  await loadIndexes();
}

function renderBA(id) {
  const el = $('#ba-' + id);
  if (!el) return;
  const p = beforeAfter[id] || {};
  if (!p.before && !p.after) { el.style.display = 'none'; return; }
  const side = (title, r) => r
    ? `<div class="side"><h5>${title}</h5><div class="big">${ms(r.ms)}</div>
       <div class="acc">${esc(r.access.join(' + ') || 'n/a')}</div>
       <div class="acc">${num(r.blocks)} blocks</div></div>`
    : `<div class="side"><h5>${title}</h5><div class="big sub">—</div><div class="acc">not measured yet</div></div>`;
  const speedup = p.before && p.after && p.after.ms > 0
    ? (p.before.ms / p.after.ms).toFixed(1) + '×'
    : '→';
  el.style.display = '';
  el.innerHTML = side('Without the index', p.before) +
                 `<div class="arrow">${speedup}</div>` +
                 side('With the index', p.after) +
                 (p.build ? `<div class="hint" style="grid-column:1/-1">built in ${p.build.buildMs} ms · index size ${p.build.size}</div>` : '');
}

$('#idxRefresh').onclick = loadIndexes;
$('#idxReset').onclick = async () => {
  await api('/api/indexes/reset', {});
  for (const k of Object.keys(beforeAfter)) delete beforeAfter[k];
  wcRuns.length = 0;
  $('#wcBars').innerHTML = '';
  await loadIndexes();
};

const wcRuns = [];
$('#wcRun').onclick = async () => {
  const btn = $('#wcRun');
  btn.disabled = true; btn.textContent = 'inserting…';
  try {
    const r = await api('/api/indexes/writecost', { rows: 20000 });
    wcRuns.push(r);
    $('#wcMetrics').innerHTML =
      metric('insert 20k rows', ms(r.ms), r.ms > 400 ? 'warn' : 'good') +
      metric('per row', r.perRowUs + ' µs') +
      metric('indexes on plays', r.indexesOnPlays, r.indexesOnPlays > 2 ? 'warn' : '');
    const worst = Math.max(...wcRuns.map(x => x.ms));
    $('#wcBars').innerHTML = wcRuns.map((x, i) => `
      <div class="bar-row">
        <span>run ${i + 1} · ${x.indexesOnPlays} index${x.indexesOnPlays === 1 ? '' : 'es'}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(x.ms / worst * 100).toFixed(1)}%;background:${x.indexesOnPlays > 2 ? 'var(--seq)' : 'var(--ok)'}"></div></div>
        <span class="bar-num">${ms(x.ms)}</span>
      </div>`).join('');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Time 20,000 inserts';
  }
};

/* ==================================================== 4. TRANSACTIONS === */
let SCENARIOS = [], picked = null;

(async () => {
  const s = await api('/api/tx');
  SCENARIOS = s.catalogue || [];
  $('#scenList').innerHTML = SCENARIOS.map(sc => `
    <button class="scen" data-id="${sc.id}">
      <b>${esc(sc.title)}</b><span>${sc.steps} steps · ${sc.levels.length} isolation level${sc.levels.length > 1 ? 's' : ''}</span>
    </button>`).join('');
  $$('#scenList .scen').forEach(b => b.onclick = () => pickScenario(b.dataset.id));
  pickScenario(SCENARIOS[0]?.id);
})();

function pickScenario(id) {
  picked = SCENARIOS.find(s => s.id === id);
  if (!picked) return;
  $$('#scenList .scen').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  $('#isoPick').innerHTML = picked.levels.map(l =>
    `<option value="${l}" ${l === picked.defaultLevel ? 'selected' : ''}>${l}</option>`).join('');
  $('#scenTeaches').textContent = picked.teaches;
  $('#stepsA').innerHTML = $('#stepsB').innerHTML = '';
  $('#scenVerdict').innerHTML = '';
  $('#scenProgress').textContent = 'Not started.';
}

const stepEl = (h) => {
  const cls = h.blocked ? 'blocked' : h.ok === false ? 'err' : h.unblockedBy ? 'freed' : '';
  let res;
  if (h.blocked) {
    res = '<span class="blink">⏳ blocked — waiting on a lock held by the other session</span>';
  } else if (h.ok === false) {
    res = '✖ ' + esc(h.error) + (h.code ? '\n\nSQLSTATE ' + h.code : '') + (h.meaning ? '\n' + esc(h.meaning) : '');
  } else if (h.rows && h.rows.length) {
    res = esc(h.rows.map(r => Object.entries(r).map(([k, v]) => k + ' = ' + v).join(', ')).join('\n'));
  } else {
    res = esc((h.command || 'ok') + (h.rowCount != null ? ' · ' + h.rowCount + ' row(s)' : '')) + '  ' + ms(h.ms);
  }
  return `<li class="step ${cls}">
    <div class="lbl"><b>${h.n}.</b> ${esc(h.label)}</div>
    <pre class="sql">${esc(h.sql)}</pre>
    <pre class="res">${res}</pre>
    ${h.resolvedNote ? `<div class="note">✓ ${esc(h.resolvedNote)}</div>` : ''}
    ${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}
  </li>`;
};

function renderTx(s) {
  if (!s.ok) return;
  for (const sess of s.sessions || []) {
    const el = $('#pid' + sess.name);
    if (el) el.textContent = 'pid ' + sess.pid + (sess.inTx ? ' · in transaction' : '');
  }
  $('#stepsA').innerHTML = s.history.filter(h => h.session === 'A').map(stepEl).join('');
  $('#stepsB').innerHTML = s.history.filter(h => h.session === 'B').map(stepEl).join('');
  $('#scenProgress').textContent = s.done
    ? 'Finished — ' + s.scenario.total + ' of ' + s.scenario.total + ' steps at ' + s.isolation + '.'
    : 'Step ' + s.cursor + ' of ' + s.scenario.total + ' at ' + s.isolation +
      (s.next ? ' · next: session ' + s.next.session + ' — ' + s.next.label : '');

  if (s.verdict) {
    $('#scenVerdict').innerHTML = `<div class="verdict ${s.verdict.ok ? 'good' : 'bad'}">
      <h4>${s.verdict.ok ? '✓ The invariant held' : '✖ Anomaly reproduced'}</h4>
      <p>${esc(s.verdict.text)}</p>
      ${s.verdict.detail ? `<p class="code">${esc(s.verdict.detail)}</p>` : ''}
      ${!s.verdict.ok ? '<p class="code">Now raise the isolation level and run the identical script again.</p>' : ''}
    </div>`;
  } else {
    $('#scenVerdict').innerHTML = '';
  }
  $('#scenStep').disabled = s.done;
  $('#scenAll').disabled = s.done;
}

$('#scenStart').onclick = async () => {
  if (!picked) return;
  renderTx(await api('/api/tx/start', { id: picked.id, level: $('#isoPick').value }));
};
$('#scenStep').onclick = async () => renderTx(await api('/api/tx/step', {}));
$('#scenAll').onclick = async () => {
  $('#scenAll').disabled = true;
  renderTx(await api('/api/tx/runall', {}));
};
$('#scenReset').onclick = async () => {
  await api('/api/tx/reset', {});
  pickScenario(picked?.id);
};

/* ==================================================== 5. LOCKS ========== */
let lkTimer = null;

async function loadLocks() {
  const l = await api('/api/locks');
  $('#lkBlocking').innerHTML = l.blocking.length
    ? '<tr><th>Waiting PID</th><th>State</th><th>Waiting for</th><th>Blocked by</th><th>Seconds</th><th>Its query</th></tr>' +
      l.blocking.map(r => `<tr>
        <td class="mono">${r.waiting_pid}</td>
        <td><span class="pill ${r.blocking_pid ? 'bad' : 'seq'}">${esc(r.waiting_state)}</span></td>
        <td class="mono">${esc([r.wait_event_type, r.wait_event].filter(Boolean).join(' / ') || '—')}</td>
        <td class="mono">${r.blocking_pid ?? '—'}</td>
        <td class="mono">${r.waiting_seconds ?? '—'}</td>
        <td class="mono sub">${esc(r.waiting_query || '')}</td>
      </tr>`).join('')
    : '<tr><td class="hint">Nothing is blocked right now. Start the deadlock or FOR UPDATE scenario in tab 4 and stop at the blocking step.</td></tr>';

  $('#lkHeld').innerHTML = l.held.length
    ? '<tr><th>PID</th><th>Type</th><th>Mode</th><th>Granted</th><th>Relation</th></tr>' +
      l.held.map(r => `<tr>
        <td class="mono">${r.pid}</td>
        <td class="mono">${esc(r.locktype)}</td>
        <td class="mono">${esc(r.mode)}</td>
        <td>${r.granted ? '<span class="pill ok">yes</span>' : '<span class="pill bad">WAITING</span>'}</td>
        <td class="mono">${esc(r.relation || '—')}</td>
      </tr>`).join('')
    : '<tr><td class="hint">No locks held on the lab tables.</td></tr>';
}

$('#lkRefresh').onclick = loadLocks;
$('#lkAuto').onchange = (e) => {
  clearInterval(lkTimer);
  if (e.target.checked) lkTimer = setInterval(loadLocks, 2000);
};

/* ==================================================== 6. N+1 ============ */
$('#npRun').onclick = async () => {
  const btn = $('#npRun');
  btn.disabled = true; btn.textContent = 'running…';
  try {
    const r = await api('/api/nplus1?artist=' + encodeURIComponent($('#npArtist').value));
    $('#npHint').textContent = r.indexHint;
    const worst = Math.max(...r.results.map(x => x.ms));
    $('#npBars').innerHTML = r.results.map(x => `
      <div class="bar-row">
        <span>${esc(x.label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(x.ms / worst * 100).toFixed(1)}%;background:${x.queries > 3 ? 'var(--seq)' : 'var(--ok)'}"></div></div>
        <span class="bar-num">${ms(x.ms)} · ${x.queries} q</span>
      </div>`).join('');
    $('#npTable').innerHTML =
      '<tr><th>Approach</th><th>Queries</th><th>Wall</th><th>In the DB</th><th>Albums</th><th>Tracks</th><th>Note</th></tr>' +
      r.results.map(x => `<tr>
        <td>${esc(x.label)}</td>
        <td class="mono">${x.queries > 3 ? `<span class="pill seq">${x.queries}</span>` : `<span class="pill ok">${x.queries}</span>`}</td>
        <td class="mono">${ms(x.ms)}</td>
        <td class="mono">${ms(x.dbMs)}</td>
        <td class="mono">${x.albums}</td>
        <td class="mono">${x.tracks}</td>
        <td class="sub">${esc(x.note)}</td>
      </tr>`).join('');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Build the artist page three ways';
  }
};

/* ==================================================== 7. POOL =========== */
async function loadBudget() {
  const b = await api('/api/pool/budget');
  $('#poolSize').textContent = 'pool size is ' + b.appPoolSize;
  $('#budgetTable').innerHTML = `
    <tr><th>Server max_connections</th><td class="mono">${b.max_connections}</td></tr>
    <tr><th>Connections in use (all databases)</th><td class="mono">${b.current_total}</td></tr>
    <tr><th>Connections to this database</th><td class="mono">${b.current_db}</td></tr>
    <tr><th>Idle in transaction</th><td class="mono">${b.idle_in_transaction > 0 ? `<span class="pill bad">${b.idle_in_transaction}</span>` : 0}</td></tr>
    <tr><th>This app's pool size</th><td class="mono">${b.appPoolSize}</td></tr>`;
}

$('#ccRun').onclick = async () => {
  const btn = $('#ccRun');
  btn.disabled = true; btn.textContent = 'measuring…';
  try {
    const r = await api('/api/pool/connectcost', { rounds: 5 });
    $('#ccMetrics').innerHTML =
      metric('new connection', ms(r.newConnectionMs), 'bad') +
      metric('pooled', ms(r.pooledMs), 'good') +
      metric('difference', r.ratio + '×', 'warn');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Compare new connection vs pooled';
  }
};

$('#poolRun').onclick = async () => {
  const btn = $('#poolRun');
  btn.disabled = true; btn.textContent = 'running…';
  try {
    const r = await api('/api/pool', {
      concurrency: Number($('#poolN').value), workMs: Number($('#poolW').value)
    });
    $('#poolMetrics').innerHTML =
      metric('pool size', r.poolSize) +
      metric('concurrency', r.concurrency, r.concurrency > r.poolSize ? 'warn' : 'good') +
      metric('total', ms(r.totalMs)) +
      metric('predicted', ms(r.theoreticalMs)) +
      metric('queue wait p50', ms(r.queueWait.p50), r.queueWait.p50 > 1 ? 'warn' : 'good') +
      metric('queue wait p95', ms(r.queueWait.p95), r.queueWait.p95 > 1 ? 'bad' : 'good');
    const v = $('#poolVerdict');
    v.style.display = '';
    v.innerHTML = `<p style="margin:0">${esc(r.verdict)}</p><p class="hint" style="margin:8px 0 0">${esc(r.readMe)}</p>`;
    loadBudget();
  } finally {
    btn.disabled = false; btn.textContent = '▶ Run';
  }
};
