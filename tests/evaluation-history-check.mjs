import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const scratch = mkdtempSync(join(tmpdir(), 'iost-evaluation-history-'));
process.env.IOST_DATA_DIR = scratch;
process.env.EVALUATION_HISTORY_MAX_RUNS = '3';
process.env.EVALUATION_HISTORY_RETENTION_DAYS = '30';

const { evaluateAgentStrategy } = await import('../lib/evaluation.js');
const history = await import('../lib/evaluation-history.js');

function candles(count = 260) {
  const rows = []; let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price; price = Math.max(1, price + (i % 25 < 17 ? 0.45 : -0.3) + Math.sin(i / 4) * 0.15);
    rows.push({ ts: 1_700_000_000_000 + i * 86_400_000, o: open, h: Math.max(open, price) + 0.3,
      l: Math.min(open, price) - 0.3, c: price, v: 1000 + i });
  }
  return rows;
}

const strategy = { name: '=EVIDENCE()', side: 'long', sizePct: 0.5,
  entry: { rule: 'breakout', params: { lookback: 8 } }, exit: { stopPct: 0.025, targetPct: 0.05, maxBars: 12 } };
const config = { trainBars: 80, testBars: 40, stepBars: 40, minimumTrades: 30,
  costs: { feeBps: 10, spreadBps: 8, slippageBps: 6 } };
const evaluation = evaluateAgentStrategy({ symbol: 'BTC', timeframe: '1d', strategy, candles: candles(), config });
assert.equal(evaluation.ok, true);

try {
  const now = 1_800_000_000_000;
  history.saveEvaluation('user-a-private-id', evaluation, now - 31 * 86_400_000);
  const first = history.saveEvaluation('user-a-private-id', evaluation, now - 2);
  const second = history.saveEvaluation('user-a-private-id', evaluation, now - 1);
  const third = history.saveEvaluation('user-a-private-id', evaluation, now);

  const own = history.listEvaluations('user-a-private-id', 50, now);
  assert.equal(own.runs.length, 3, 'count and age retention must prune old history');
  assert.equal(own.retention.maxRuns, 3);
  assert.equal(history.listEvaluations('user-b-private-id', 50, now).runs.length, 0, 'another user must see no runs');
  assert.equal(history.getEvaluation('user-b-private-id', first.id), null, 'cross-user id lookup must fail closed');
  const aging = history.saveEvaluation('aging-user', evaluation, now - 31 * 86_400_000);
  assert.equal(history.getEvaluation('aging-user', aging.id, now), null, 'expired runs must not be readable by direct id');

  const comparison = history.compareEvaluations('user-a-private-id', [first.id, second.id]);
  assert.equal(comparison.runs.length, 2);
  assert.equal(comparison.mode, 'paper-only');
  assert.equal(comparison.boundary.includes('cannot authorize'), true);
  assert.throws(() => history.compareEvaluations('user-a-private-id', [first.id, first.id]), /two distinct/);

  const jsonA = history.exportEvaluationJson('user-a-private-id', third.id);
  const jsonB = history.exportEvaluationJson('user-a-private-id', third.id);
  assert.equal(jsonA, jsonB, 'JSON evidence export must be byte deterministic');
  const exported = JSON.parse(jsonA);
  assert.equal(exported.resultHash, evaluation.evidence.resultHash);
  assert.equal(exported.evaluation.evidence.resultHash, evaluation.evidence.resultHash);
  assert.equal(jsonA.includes('user-a-private-id'), false);
  assert.equal(Object.hasOwn(exported, 'createdAt'), false);
  assert.equal(Object.hasOwn(exported, 'id'), false);

  const csvA = history.exportEvaluationCsv('user-a-private-id', third.id);
  const csvB = history.exportEvaluationCsv('user-a-private-id', third.id);
  assert.equal(csvA, csvB, 'CSV evidence export must be byte deterministic');
  assert.equal(csvA.includes(evaluation.evidence.resultHash), true);
  assert.equal(csvA.includes('"\'=EVIDENCE()"'), true, 'CSV formulas must be neutralized');
  assert.equal(csvA.includes('user-a-private-id'), false);

  const files = readdirSync(history.evaluationHistoryPathsForTest.historyDir);
  assert.equal(files.length, 1, 'only the owner with retained history gets a store');
  assert.equal(files[0].includes('user-a-private-id'), false, 'store names must not expose owner ids');
  const file = join(history.evaluationHistoryPathsForTest.historyDir, files[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(history.evaluationHistoryPathsForTest.historyDir).mode & 0o777, 0o700);
  chmodSync(file, 0o644); chmodSync(history.evaluationHistoryPathsForTest.historyDir, 0o755);
  history.secureEvaluationHistoryPermissions();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'boot permission repair must restore owner-only files');
  assert.equal(statSync(history.evaluationHistoryPathsForTest.historyDir).mode & 0o777, 0o700, 'boot permission repair must restore owner-only directory');

  const swappedName = crypto.createHash('sha256').update('iost-terminal:evaluation-history:user-b-private-id').digest('hex') + '.json';
  const swappedFile = join(history.evaluationHistoryPathsForTest.historyDir, swappedName);
  copyFileSync(file, swappedFile);
  assert.throws(() => history.listEvaluations('user-b-private-id', 3, now), /integrity check failed/, 'a store copied between owners must fail closed');
  rmSync(swappedFile);

  process.env.EVALUATION_HISTORY_MAX_RUNS = '25';
  const started = performance.now();
  for (let i = 0; i < 25; i++) history.saveEvaluation('performance-user', evaluation, now + i);
  const perfList = history.listEvaluations('performance-user', 25, now + 25);
  history.compareEvaluations('performance-user', [perfList.runs[0].id, perfList.runs[1].id]);
  history.exportEvaluationCsv('performance-user', perfList.runs[0].id);
  assert.ok(performance.now() - started < 2_000, 'bounded history operations must remain responsive');

  const tampered = JSON.parse(readFileSync(file, 'utf8'));
  tampered.runs[0].evaluation.metrics.trades += 1;
  writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });
  assert.throws(() => history.listEvaluations('user-a-private-id', 3, now), /integrity check failed/, 'tampered history must fail closed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('Evaluation history, privacy, export, integrity and performance checks passed');
