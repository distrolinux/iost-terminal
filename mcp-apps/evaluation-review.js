import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'IOST Terminal Evaluation Review', version: '1.0.0' });
const byId = (id) => document.getElementById(id);
const selected = new Set();
let currentRun = null;
let currentTaskId = null;
let pollTimer = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function status(message, error = false) { byId('status').textContent = message; byId('status').className = error ? 'status hold' : 'status'; }
function value(number, suffix = '') { return Number.isFinite(number) ? `${number}${suffix}` : '—'; }

function dataFrom(result) {
  if (result?.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text || 'Tool request failed');
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('The MCP host returned no structured data');
  return JSON.parse(text);
}

async function call(name, args = {}) {
  return dataFrom(await app.callServerTool({ name, arguments: args }));
}

function renderAuthorization(auth = {}) {
  const wallet = auth.wallet;
  const activePacts = Array.isArray(auth.pacts) ? auth.pacts.filter((pact) => pact.status === 'active') : [];
  const parts = [auth.canOpenPaperTrade ? 'Paper execution ready.' : 'Paper execution is not ready.'];
  parts.push(wallet ? `Wallet: ${wallet.name || wallet.walletId} (${wallet.status}).` : 'No owned agent wallet found.');
  parts.push(`${activePacts.length} active Pact${activePacts.length === 1 ? '' : 's'}.`);
  parts.push('MetaMask binding proves wallet ownership only; it does not grant trade authority.');
  byId('authText').textContent = parts.join(' ');
}

function appendCell(row, text) { const cell = element('td', text); row.appendChild(cell); return cell; }

function renderHistory(payload = {}) {
  const history = payload.history || payload;
  const runs = Array.isArray(history.runs) ? history.runs : [];
  const body = byId('historyBody'); clear(body); selected.clear(); byId('compare').disabled = true;
  if (!runs.length) { const row = element('tr'); const cell = appendCell(row, 'No retained evaluations yet.'); cell.colSpan = 6; body.appendChild(row); return; }
  for (const run of runs) {
    const row = element('tr'); const selectCell = appendCell(row, '');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `Select ${run.strategy?.name || run.id} for comparison`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selected.size >= 2) { checkbox.checked = false; status('Select exactly two runs for comparison.', true); return; }
      if (checkbox.checked) selected.add(run.id); else selected.delete(run.id);
      byId('compare').disabled = selected.size !== 2;
    });
    selectCell.appendChild(checkbox);
    appendCell(row, `${run.symbol || '—'} · ${run.strategy?.name || run.id}`);
    appendCell(row, Number.isFinite(run.createdAt) ? new Date(run.createdAt).toLocaleString() : '—');
    appendCell(row, value(run.metrics?.cumulativeReturnPct, '%'));
    appendCell(row, run.promotion?.decision || 'HOLD');
    const actions = appendCell(row, ''); const view = element('button', 'View'); view.type = 'button';
    view.addEventListener('click', () => loadRun(run.id)); actions.appendChild(view); body.appendChild(row);
  }
}

function metric(label, display, tone) { const node = element('div', null, 'kpi'); node.append(element('span', label), element('strong', display, tone)); return node; }

function tableFor(headers, rows) {
  const table = element('table'); const head = element('thead'); const headerRow = element('tr');
  for (const label of headers) { const th = element('th', label); th.scope = 'col'; headerRow.appendChild(th); }
  head.appendChild(headerRow); table.appendChild(head); const body = element('tbody');
  for (const values of rows) { const row = element('tr'); for (const item of values) appendCell(row, item); body.appendChild(row); }
  table.appendChild(body); return table;
}

function drawLines(canvas, datasets, key = 'equity') {
  const ctx = canvas.getContext('2d'); const width = canvas.width; const height = canvas.height; const pad = 28;
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#081219'; ctx.fillRect(0, 0, width, height);
  const points = datasets.flatMap((set) => set.points || []).filter((point) => Number.isFinite(point?.[key]));
  if (points.length < 2) { ctx.fillStyle = '#a7bdca'; ctx.fillText('Not enough evidence to draw this chart', pad, height / 2); return; }
  const values = points.map((point) => point[key]); const low = Math.min(...values); const high = Math.max(...values); const span = high - low || 1;
  const maxLength = Math.max(...datasets.map((set) => set.points?.length || 0));
  ctx.strokeStyle = '#28404f'; ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, height - pad); ctx.lineTo(width - pad, height - pad); ctx.stroke();
  for (const set of datasets) {
    const series = (set.points || []).filter((point) => Number.isFinite(point?.[key])); if (series.length < 2) continue;
    ctx.strokeStyle = set.color; ctx.lineWidth = 2; ctx.beginPath();
    series.forEach((point, index) => { const x = pad + index / Math.max(1, maxLength - 1) * (width - pad * 2); const y = height - pad - (point[key] - low) / span * (height - pad * 2); if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  }
}

function renderSeriesTable(targetId, datasets, key) {
  const target = byId(targetId); clear(target); const rows = []; const longest = Math.max(0, ...datasets.map((set) => set.points?.length || 0));
  for (let index = 0; index < longest; index++) rows.push([String(index), ...datasets.map((set) => value(set.points?.[index]?.[key]))]);
  target.appendChild(tableFor(['Point', ...datasets.map((set) => set.label)], rows));
}

function renderRun(run) {
  currentRun = run; const evaluation = run.evaluation || run; const metrics = evaluation.metrics || {}; const calibration = evaluation.calibration || {};
  byId('evidence').classList.remove('hidden'); const kpis = byId('kpis'); clear(kpis);
  kpis.append(metric('Net return', value(metrics.cumulativeReturnPct, '%'), (metrics.cumulativeReturnPct || 0) >= 0 ? 'review' : 'hold'), metric('Max drawdown', value(metrics.maxDrawdownPct, '%'), 'hold'), metric('Trades', value(metrics.trades)), metric('Calibration error', value(calibration.expectedCalibrationError)));
  byId('methodology').textContent = `${evaluation.methodology?.split || 'rolling walk-forward'} · ${evaluation.methodology?.execution || 'next-bar-open'} · costs included`;
  byId('evidenceHash').textContent = `Evidence hash: ${evaluation.evidence?.resultHash || 'unavailable'}`;
  const reasons = byId('gateReasons'); clear(reasons); const decision = evaluation.promotion?.decision || 'HOLD'; reasons.appendChild(element('p', `Paper-review gate: ${decision}`, decision === 'HOLD' ? 'hold' : 'review'));
  for (const reason of evaluation.promotion?.failures || []) reasons.appendChild(element('p', reason, 'warning'));
  for (const warning of evaluation.warnings || []) reasons.appendChild(element('p', warning, 'warning'));
  const equity = [{ label: 'Strategy', color: '#31e6ff', points: evaluation.series?.equity || [] }, { label: 'Buy & hold', color: '#ffd166', points: evaluation.series?.baselines?.buyAndHold || [] }, { label: 'SMA', color: '#48efb1', points: evaluation.series?.baselines?.smaCross || [] }];
  drawLines(byId('equityChart'), equity); renderSeriesTable('equityTable', equity, 'equity');
  const drawdown = [{ label: 'Drawdown %', color: '#ff746d', points: evaluation.series?.drawdown || [] }]; drawLines(byId('drawdownChart'), drawdown, 'drawdownPct'); renderSeriesTable('drawdownTable', drawdown, 'drawdownPct');
  const baselines = equity.slice(1); drawLines(byId('baselineChart'), baselines); renderSeriesTable('baselineTable', baselines, 'equity');
  const buckets = calibration.buckets || []; const calibrationLines = [
    { label: 'Predicted', color: '#31e6ff', points: buckets.map((bucket) => ({ value: bucket.predicted })) },
    { label: 'Observed', color: '#48efb1', points: buckets.map((bucket) => ({ value: bucket.observed })) },
  ];
  drawLines(byId('calibrationChart'), calibrationLines, 'value');
  const calibrationTarget = byId('calibrationTable'); clear(calibrationTarget); calibrationTarget.appendChild(tableFor(['Range', 'Predicted', 'Observed', 'Count'], buckets.map((bucket) => [bucket.range, value(bucket.predicted), value(bucket.observed), value(bucket.count)])));
  status(`Showing verified ${evaluation.symbol || ''} evaluation evidence.`);
}

function renderComparison(comparison) {
  const runs = comparison.runs || []; if (runs.length !== 2) throw new Error('Comparison requires exactly two retained runs');
  const synthetic = { evaluation: { ...runs[1], series: { ...runs[1].series, equity: runs[1].series?.equity }, warnings: [`Comparison: ${runs[0].symbol} versus ${runs[1].symbol}. Metric deltas are second minus first.`] } };
  renderRun(synthetic);
  const datasets = runs.map((run, index) => ({ label: index ? `B ${run.symbol}` : `A ${run.symbol}`, color: index ? '#48efb1' : '#31e6ff', points: run.series?.equity || [] }));
  drawLines(byId('equityChart'), datasets); renderSeriesTable('equityTable', datasets, 'equity'); status('Showing a same-owner two-run comparison.');
}

async function loadRun(runId) { try { status('Loading private evidence…'); renderRun(await call('evaluation_get', { runId })); } catch (error) { status(error.message, true); } }

async function refresh() { try { status('Refreshing retained evaluations…'); const payload = await call('evaluation_history', { limit: 25 }); renderHistory(payload); status('Private evaluation history refreshed.'); } catch (error) { status(error.message, true); } }

async function compareRuns() { try { status('Comparing retained evidence…'); renderComparison(await call('evaluation_compare', { runIds: [...selected] })); } catch (error) { status(error.message, true); } }

async function download(format) {
  try {
    if (!currentRun?.id) throw new Error('Select a retained run before exporting');
    status(`Preparing deterministic ${format.toUpperCase()} evidence…`); const payload = await call('evaluation_export', { runId: currentRun.id, format });
    const blob = new Blob([payload.data], { type: payload.mimeType }); const url = URL.createObjectURL(blob); const anchor = element('a'); anchor.href = url; anchor.download = payload.filename; anchor.click(); URL.revokeObjectURL(url);
    status(`${payload.filename} ready · SHA-256 ${payload.sha256}`);
  } catch (error) { status(error.message, true); }
}

function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

async function pollTask() {
  stopPolling(); if (!currentTaskId || document.hidden) return;
  try {
    const task = await call('evaluation_task_status', { taskId: currentTaskId }); byId('taskText').textContent = `${task.status}: ${task.statusMessage || ''}`;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') { byId('cancelTask').disabled = true; if (task.status === 'completed') await refresh(); return; }
    pollTimer = setTimeout(pollTask, Math.max(1000, task.pollIntervalMs || 1000));
  } catch (error) { status(error.message, true); }
}

async function cancelTask() { try { const task = await call('evaluation_task_cancel', { taskId: currentTaskId }); byId('taskText').textContent = `${task.status}: ${task.statusMessage}`; byId('cancelTask').disabled = true; stopPolling(); } catch (error) { status(error.message, true); } }

function receive(payload) {
  try {
    const data = dataFrom(payload); if (data.history) renderHistory(data.history); if (data.authorization) renderAuthorization(data.authorization); if (data.selected?.length === 1) renderRun(data.selected[0]); if (data.comparison) renderComparison(data.comparison);
    if (data.task?.taskId) { currentTaskId = data.task.taskId; byId('taskPanel').classList.remove('hidden'); pollTask(); }
    status('Private paper evaluation review is ready.');
  } catch (error) { status(error.message, true); }
}

byId('refresh').addEventListener('click', refresh); byId('compare').addEventListener('click', compareRuns); byId('exportJson').addEventListener('click', () => download('json')); byId('exportCsv').addEventListener('click', () => download('csv')); byId('cancelTask').addEventListener('click', cancelTask);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPolling(); else if (currentTaskId) pollTask(); });
app.ontoolresult = receive;
app.connect().then(() => status('Connected. Waiting for private evaluation evidence…')).catch((error) => status(`MCP host connection failed: ${error.message}`, true));
