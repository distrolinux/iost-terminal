import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentBenchmark, verifyAgentBenchmark } from '../lib/agent-benchmark.js';
import { evaluateAgentStrategy, verifyEvaluationEvidence } from '../lib/evaluation.js';

function candles(count = 300) {
  const rows = []; let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = Math.max(1, price + (i % 24 < 17 ? 0.5 : -0.45) + Math.sin(i / 3) * 0.2);
    rows.push({ ts: 1_700_000_000_000 + i * 3_600_000, o: open, h: Math.max(open, price) + 0.3,
      l: Math.min(open, price) - 0.3, c: price, v: 1_000 + i });
  }
  return rows;
}

const strategy = { name: 'AITT benchmark specimen', side: 'long', sizePct: 0.5,
  entry: { rule: 'breakout', params: { lookback: 8 } }, exit: { stopPct: 0.02, targetPct: 0.04, maxBars: 12 } };
const config = { trainBars: 80, testBars: 40, stepBars: 40, minimumTrades: 1,
  costs: { feeBps: 10, spreadBps: 8, slippageBps: 5 } };

const evaluation = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1h', strategy, candles: candles(), config });
assert.equal(evaluation.ok, true);
assert.equal(evaluation.benchmark.status, 'verified');
assert.equal(evaluation.benchmark.manifest.protocol, 'aitt-verified-agent-benchmark');
assert.equal(evaluation.benchmark.manifest.mode, 'paper-only');
assert.match(evaluation.benchmark.manifest.checksum, /^[a-f0-9]{64}$/);
assert.match(evaluation.benchmark.evidenceHash, /^[a-f0-9]{64}$/);
assert.equal(evaluation.benchmark.trace.coveragePct, 100);
assert.equal(evaluation.benchmark.safeguards.privateByDefault, true);
assert.equal(evaluation.benchmark.safeguards.publicSummaryPublished, false);
assert.equal(evaluation.benchmark.safeguards.executionAuthority, 'none');
assert.equal(evaluation.benchmark.safeguards.automaticPromotion, false);
assert.equal(evaluation.benchmark.safeguards.liveScopeUsed, false);
assert.equal(evaluation.benchmark.safeguards.publicChainUsed, false);
assert.equal(verifyAgentBenchmark(evaluation), true);
assert.equal(verifyEvaluationEvidence(evaluation), true);

const rebuilt = createAgentBenchmark(evaluation, evaluation.trades);
assert.deepEqual(rebuilt, evaluation.benchmark, 'benchmark packaging must be deterministic');
const tampered = structuredClone(evaluation);
tampered.benchmark.score.total = 100;
assert.equal(verifyAgentBenchmark(tampered), false, 'tampered benchmark must fail closed');
assert.equal(verifyEvaluationEvidence(tampered), false, 'evaluation verification must include the benchmark');

const changedCosts = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1h', strategy, candles: candles(),
  config: { ...config, costs: { ...config.costs, feeBps: 11 } } });
assert.notEqual(changedCosts.benchmark.manifest.checksum, evaluation.benchmark.manifest.checksum,
  'locked cost changes must produce a new manifest checksum');

const noTrade = createAgentBenchmark({
  mode: 'paper-only', symbol: 'IOST', timeframe: '1h', strategy,
  config, methodology: { parameters: 'frozen before evaluation', execution: 'next-bar-open' }, folds: [], baselines: { cash: {} },
  audit: { ok: true, strategyHash: 'a'.repeat(64), dataHash: 'b'.repeat(64) },
  promotion: { decision: 'HOLD', scorecard: { score: 0, grade: 'F', confidence: 'low', components: {}, robustness: {} } },
}, []);
assert.equal(noTrade.trace.noTradeRun, true);
assert.equal(noTrade.trace.coveragePct, 100);
assert.match(noTrade.trace.note, /not presented as profitable/);

const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
assert.match(protocol, /readTool\('agent_benchmark_scorecards'/);
assert.doesNotMatch(protocol.match(/readTool\('agent_benchmark_scorecards'[\s\S]{0,600}/)?.[0] || '', /mutationTool|trade-live|public-chain writes/);
assert.match(server, /case 'agent_benchmark_scorecards'/);
assert.match(server, /app\.get\('\/api\/agent-benchmarks', requireUser/);
assert.match(app, /AITT VERIFIED AGENT BENCHMARK/);
assert.match(app, /trace coverage/);
assert.match(css, /\.benchmark-proof/);

console.log('AITT Verified Agent Benchmark checks passed');
