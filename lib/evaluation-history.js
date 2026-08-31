// Private, per-user Agent Evaluation Lab history and deterministic evidence exports.
// Files are keyed by a one-way owner digest, contain no email/user id, and are
// never shared across principals. Evaluation evidence remains paper-only.
import crypto from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceHash, stableStringify, verifyEvaluationEvidence } from './evaluation.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const HISTORY_DIR = join(DATA_DIR, 'evaluation-history');
const STORE_VERSION = 1;
const DEFAULT_MAX_RUNS = 25;
const HARD_MAX_RUNS = 100;
const DEFAULT_RETENTION_DAYS = 90;
const HARD_MAX_RETENTION_DAYS = 365;
const MAX_STORED_EVALUATION_BYTES = 2_000_000;
const RUN_ID_RE = /^ev_[a-f0-9]{24}$/;

const integerEnv = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};

export function retentionPolicy() {
  return {
    maxRuns: integerEnv('EVALUATION_HISTORY_MAX_RUNS', DEFAULT_MAX_RUNS, 1, HARD_MAX_RUNS),
    retentionDays: integerEnv('EVALUATION_HISTORY_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, HARD_MAX_RETENTION_DAYS),
  };
}

function ownerDigest(ownerId) {
  const value = String(ownerId || '');
  if (!value || value.length > 200) throw new Error('evaluation history owner required');
  return crypto.createHash('sha256').update(`iost-terminal:evaluation-history:${value}`).digest('hex');
}

function storeFile(ownerId) {
  return join(HISTORY_DIR, `${ownerDigest(ownerId)}.json`);
}

function readStore(ownerId) {
  const file = storeFile(ownerId);
  if (!existsSync(file)) return { version: STORE_VERSION, runs: [] };
  const fileStat = lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('evaluation history integrity check failed');
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('evaluation history integrity check failed'); }
  if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.runs)) throw new Error('evaluation history integrity check failed');
  return parsed;
}

export function secureEvaluationHistoryPermissions() {
  if (!existsSync(HISTORY_DIR)) return;
  const dirStat = lstatSync(HISTORY_DIR);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('evaluation history directory is unsafe');
  chmodSync(HISTORY_DIR, 0o700);
  if ((statSync(HISTORY_DIR).mode & 0o777) !== 0o700) throw new Error('evaluation history directory permissions must be 0700');
  for (const name of readdirSync(HISTORY_DIR)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = join(HISTORY_DIR, name); const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('evaluation history file is unsafe');
    chmodSync(file, 0o600);
    if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('evaluation history permissions must be 0600');
  }
}

function writeStore(ownerId, store) {
  mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HISTORY_DIR, 0o700);
  const file = storeFile(ownerId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('evaluation history permissions must be 0600');
}

function writeRetainedStore(ownerId, store, retained) {
  store.runs = retained;
  if (retained.length) writeStore(ownerId, store);
  else {
    const file = storeFile(ownerId);
    if (existsSync(file)) unlinkSync(file);
  }
}

function recordHash(ownerId, run) {
  return evidenceHash({ ownerDigest: ownerDigest(ownerId), id: run.id, createdAt: run.createdAt, resultHash: run.evaluation?.evidence?.resultHash });
}

function verified(ownerId, run) {
  return !!(run && RUN_ID_RE.test(run.id) && Number.isFinite(run.createdAt)
    && run.recordHash === recordHash(ownerId, run) && verifyEvaluationEvidence(run.evaluation));
}

function prune(runs, now = Date.now()) {
  const policy = retentionPolicy();
  const cutoff = now - policy.retentionDays * 86_400_000;
  return runs.filter((run) => run.createdAt >= cutoff).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, policy.maxRuns);
}

function summary(run) {
  const evaluation = run.evaluation;
  return {
    id: run.id, createdAt: run.createdAt, symbol: evaluation.symbol, timeframe: evaluation.timeframe,
    strategy: { name: evaluation.strategy?.name || evaluation.strategy?.entry?.rule || 'strategy', rule: evaluation.strategy?.entry?.rule },
    metrics: evaluation.metrics, baselines: evaluation.baselines, calibration: evaluation.calibration,
    promotion: evaluation.promotion, evidence: evaluation.evidence,
  };
}

export function saveEvaluation(ownerId, evaluation, now = Date.now()) {
  if (!verifyEvaluationEvidence(evaluation)) throw new Error('evaluation evidence integrity check failed');
  const serialized = stableStringify(evaluation);
  if (Buffer.byteLength(serialized) > MAX_STORED_EVALUATION_BYTES) throw new Error('evaluation evidence exceeds storage limit');
  const store = readStore(ownerId);
  if (store.runs.some((run) => !verified(ownerId, run))) throw new Error('evaluation history integrity check failed');
  const run = {
    id: `ev_${crypto.randomBytes(12).toString('hex')}`,
    createdAt: Math.trunc(now), evaluation: JSON.parse(serialized),
  };
  run.recordHash = recordHash(ownerId, run);
  store.runs = prune([run, ...store.runs], now);
  writeStore(ownerId, store);
  return summary(run);
}

export function listEvaluations(ownerId, limit = DEFAULT_MAX_RUNS, now = Date.now()) {
  const store = readStore(ownerId);
  if (store.runs.some((run) => !verified(ownerId, run))) throw new Error('evaluation history integrity check failed');
  const retained = prune(store.runs, now);
  if (retained.length !== store.runs.length) writeRetainedStore(ownerId, store, retained);
  const take = Math.min(Math.max(Number(limit) || DEFAULT_MAX_RUNS, 1), retentionPolicy().maxRuns);
  return { runs: retained.slice(0, take).map(summary), retention: retentionPolicy() };
}

export function listStrategyScorecards(ownerId, limit = DEFAULT_MAX_RUNS, now = Date.now()) {
  const history = listEvaluations(ownerId, limit, now);
  return {
    mode: 'paper-only',
    generatedAt: Math.trunc(now),
    scorecards: history.runs.map((run) => ({
      runId: run.id,
      createdAt: run.createdAt,
      symbol: run.symbol,
      timeframe: run.timeframe,
      strategy: run.strategy,
      resultHash: run.evidence?.resultHash || null,
      decision: run.promotion?.decision || 'HOLD',
      failures: run.promotion?.failures || ['promotion-evidence-unavailable'],
      scorecard: run.promotion?.scorecard || null,
    })),
    retention: history.retention,
    boundary: 'Read-only scorecards cannot change agent state, execution permissions, money, tokens or public-chain state.',
  };
}

export function getEvaluation(ownerId, runId, now = Date.now()) {
  if (!RUN_ID_RE.test(String(runId || ''))) return null;
  const store = readStore(ownerId);
  if (store.runs.some((run) => !verified(ownerId, run))) throw new Error('evaluation history integrity check failed');
  const retained = prune(store.runs, now);
  if (retained.length !== store.runs.length) writeRetainedStore(ownerId, store, retained);
  const run = retained.find((entry) => entry.id === runId);
  if (!run) return null;
  return { ...summary(run), evaluation: run.evaluation };
}

const metricDelta = (a, b, key) => Number.isFinite(a?.[key]) && Number.isFinite(b?.[key])
  ? Math.round((b[key] - a[key] + Number.EPSILON) * 10_000) / 10_000 : null;

export function compareEvaluations(ownerId, runIds) {
  const ids = Array.isArray(runIds) ? [...new Set(runIds.map(String))] : [];
  if (ids.length !== 2 || ids.some((id) => !RUN_ID_RE.test(id))) throw new Error('exactly two distinct evaluation ids required');
  const runs = ids.map((id) => getEvaluation(ownerId, id));
  if (runs.some((run) => !run)) return null;
  const [a, b] = runs.map((run) => run.evaluation);
  const metricKeys = ['trades', 'winRatePct', 'profitFactor', 'expectancy', 'expectancyPct', 'maxDrawdownPct', 'sharpeLike', 'cumulativeReturnPct', 'finalEquity', 'totalCosts'];
  return {
    mode: 'paper-only', order: 'second minus first',
    runs: runs.map((run) => ({ ...summary(run), series: run.evaluation.series })),
    delta: Object.fromEntries(metricKeys.map((key) => [key, metricDelta(a.metrics, b.metrics, key)])),
    gateChanged: a.promotion.decision !== b.promotion.decision,
    boundary: 'Comparison is evidence review only and cannot authorize execution or any money, token, or chain action.',
  };
}

function exportDocument(run) {
  return {
    exportVersion: 1,
    evidenceType: 'iost-terminal-agent-evaluation',
    mode: 'paper-only',
    resultHash: run.evaluation.evidence.resultHash,
    evaluation: run.evaluation,
  };
}

export function exportEvaluationJson(ownerId, runId) {
  const run = getEvaluation(ownerId, runId);
  return run ? `${stableStringify(exportDocument(run))}\n` : null;
}

const CSV_COLUMNS = ['recordType', 'key', 'index', 'timestamp', 'fold', 'value', 'equity', 'drawdownPct', 'predicted', 'observed', 'count', 'side', 'entry', 'exit', 'pnl', 'resultHash'];
const csvCell = (value) => {
  const protectFormula = typeof value === 'string';
  let text = value == null ? '' : typeof value === 'object' ? stableStringify(value) : String(value);
  if (protectFormula && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export function exportEvaluationCsv(ownerId, runId) {
  const run = getEvaluation(ownerId, runId);
  if (!run) return null;
  const e = run.evaluation; const resultHash = e.evidence.resultHash; const rows = [];
  const add = (row) => rows.push(Object.fromEntries(CSV_COLUMNS.map((key) => [key, row[key] ?? ''])));
  for (const [key, value] of Object.entries({ version: e.version, mode: e.mode, symbol: e.symbol, timeframe: e.timeframe,
    strategyName: e.strategy?.name || '', strategy: e.strategy, config: e.config, methodology: e.methodology,
    metrics: e.metrics, calibration: e.calibration, warnings: e.warnings, promotion: e.promotion, audit: e.audit, evidence: e.evidence })) {
    add({ recordType: 'evidence', key, value, resultHash });
  }
  for (const [key, value] of Object.entries(e.baselines || {})) add({ recordType: 'baseline', key, value, resultHash });
  for (const fold of e.folds || []) add({ recordType: 'fold', key: 'walk-forward', fold: fold.id, value: fold, resultHash });
  for (const bucket of e.calibration?.buckets || []) add({ recordType: 'calibration', key: bucket.range, predicted: bucket.predicted, observed: bucket.observed, count: bucket.count, resultHash });
  for (const point of e.series?.equity || []) add({ recordType: 'equity', index: point.index, timestamp: point.ts, equity: point.equity, resultHash });
  for (const point of e.series?.drawdown || []) add({ recordType: 'drawdown', index: point.index, timestamp: point.ts, drawdownPct: point.drawdownPct, resultHash });
  for (const [key, points] of Object.entries(e.series?.baselines || {})) {
    for (const point of points) add({ recordType: 'baseline-series', key, index: point.index, timestamp: point.ts, equity: point.equity, resultHash });
  }
  for (const trade of e.trades || []) add({ recordType: 'trade', index: trade.entryIndex, timestamp: trade.entryTs, fold: trade.fold,
    side: trade.side, entry: trade.entry, exit: trade.exit, pnl: trade.pnl, value: trade, resultHash });
  return `${CSV_COLUMNS.map(csvCell).join(',')}\n${rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(',')).join('\n')}\n`;
}

export const evaluationHistoryPathsForTest = Object.freeze({ dataDir: DATA_DIR, historyDir: HISTORY_DIR });
