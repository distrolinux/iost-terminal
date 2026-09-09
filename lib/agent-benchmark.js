// AITT Verified Agent Benchmark — deterministic packaging of existing paper
// evaluation evidence. A benchmark describes and verifies a run; it never
// publishes evidence, promotes an agent, or changes execution authority.
import crypto from 'node:crypto';

export const AGENT_BENCHMARK_VERSION = 1;

const stableStringify = (value) => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);

const hash = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
const round = (value, precision = 2) => Number.isFinite(value)
  ? Math.round((value + Number.EPSILON) * 10 ** precision) / 10 ** precision : null;

function traceEvidence(trades = []) {
  const required = ['fold', 'signalIndex', 'signalTs', 'entryIndex', 'entryTs', 'side', 'entry', 'exitIndex', 'exitTs', 'exit', 'reason', 'pnl', 'totalCosts'];
  const complete = trades.filter((trade) => required.every((key) => trade?.[key] !== undefined && trade?.[key] !== null)).length;
  const coveragePct = trades.length ? round(complete / trades.length * 100) : 100;
  const trace = trades.map((trade) => Object.fromEntries(required.map((key) => [key, trade?.[key] ?? null])));
  return {
    decisions: trades.length,
    complete,
    coveragePct,
    noTradeRun: trades.length === 0,
    traceHash: hash(trace),
    note: trades.length ? 'Every simulated trade must retain its causal decision and cost evidence.'
      : 'No-trade runs remain visible and are not presented as profitable trading evidence.',
  };
}

export function createAgentBenchmark(evaluation, trades = []) {
  if (!evaluation?.audit?.ok || evaluation.mode !== 'paper-only') throw new Error('verified paper evaluation required');
  const folds = Array.isArray(evaluation.folds) ? evaluation.folds : [];
  const scorecard = evaluation.promotion?.scorecard || null;
  const testStarts = folds.map((fold) => Number(fold?.test?.from)).filter(Number.isFinite);
  const testEnds = folds.map((fold) => Number(fold?.test?.to)).filter(Number.isFinite);
  const manifestCore = {
    protocol: 'aitt-verified-agent-benchmark',
    version: AGENT_BENCHMARK_VERSION,
    mode: 'paper-only',
    asset: evaluation.symbol,
    timeframe: evaluation.timeframe,
    strategyHash: evaluation.audit.strategyHash,
    dataHash: evaluation.audit.dataHash,
    strategy: {
      name: evaluation.strategy?.name || evaluation.strategy?.entry?.rule || 'strategy',
      side: evaluation.strategy?.side === 'short' ? 'short' : 'long',
      rule: evaluation.strategy?.entry?.rule || null,
    },
    lockedRules: {
      parameters: evaluation.methodology?.parameters || null,
      informationBoundary: evaluation.methodology?.informationBoundary || null,
      execution: evaluation.methodology?.execution || null,
      ambiguousBarPolicy: evaluation.methodology?.ambiguousBarPolicy || null,
      costs: evaluation.config?.costs || null,
      trainBars: evaluation.config?.trainBars || null,
      testBars: evaluation.config?.testBars || null,
      stepBars: evaluation.config?.stepBars || null,
      minimumTrades: evaluation.config?.minimumTrades || null,
      executionDelayBars: evaluation.config?.executionDelayBars || 1,
    },
    evaluationWindow: {
      from: testStarts.length ? Math.min(...testStarts) : null,
      to: testEnds.length ? Math.max(...testEnds) : null,
      folds: folds.length,
    },
    baselines: Object.keys(evaluation.baselines || {}).sort(),
    challengeEvidenceHash: evaluation.challenge?.evidenceHash || null,
  };
  const trace = traceEvidence(trades);
  const benchmarkCore = {
    version: AGENT_BENCHMARK_VERSION,
    status: trace.coveragePct === 100 ? 'verified' : 'incomplete',
    decision: evaluation.promotion?.decision || 'HOLD',
    manifest: { ...manifestCore, checksum: hash(manifestCore) },
    score: {
      total: scorecard?.score ?? null,
      grade: scorecard?.grade ?? null,
      evidenceConfidence: scorecard?.confidence || 'low',
      components: scorecard?.components || {},
      benchmarkAlphaPct: scorecard?.robustness?.benchmarkAlphaPct ?? null,
      positiveFoldPct: scorecard?.robustness?.positiveFoldPct ?? null,
      overfitRiskProxy: scorecard?.robustness?.overfitRiskProxy || 'unknown',
    },
    trace,
    safeguards: {
      privateByDefault: true,
      publicationRequiresOwnerAction: true,
      publicSummaryPublished: false,
      executionAuthority: 'none',
      automaticPromotion: false,
      executionPermissionsChanged: false,
      liveScopeUsed: false,
      publicChainUsed: false,
    },
    caveat: 'A verified benchmark proves reproducible paper evidence, not future performance or investment suitability.',
  };
  return { ...benchmarkCore, evidenceHash: hash(benchmarkCore) };
}

export function verifyAgentBenchmark(evaluation) {
  const benchmark = evaluation?.benchmark;
  if (!benchmark || benchmark.version !== AGENT_BENCHMARK_VERSION || !/^[a-f0-9]{64}$/.test(benchmark.evidenceHash || '')) return false;
  const { evidenceHash, ...benchmarkCore } = benchmark;
  if (hash(benchmarkCore) !== evidenceHash) return false;
  const { checksum, ...manifestCore } = benchmark.manifest || {};
  if (!/^[a-f0-9]{64}$/.test(checksum || '') || hash(manifestCore) !== checksum) return false;
  return benchmark.status === 'verified'
    && benchmark.trace?.coveragePct === 100
    && benchmark.safeguards?.executionAuthority === 'none'
    && benchmark.safeguards?.privateByDefault === true
    && benchmark.safeguards?.executionPermissionsChanged === false;
}
