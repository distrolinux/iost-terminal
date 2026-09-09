// AITT Agent Challenge Lab — deterministic stress packaging for paper-only
// evaluations. Challenge evidence is advisory and never changes authority.
import crypto from 'node:crypto';

export const AGENT_CHALLENGE_VERSION = 1;

const stableStringify = (value) => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
const round = (value, precision = 2) => Number.isFinite(value)
  ? Math.round((value + Number.EPSILON) * 10 ** precision) / 10 ** precision : null;

export function createAgentChallenge(nominal, stressRuns = []) {
  if (!nominal?.ok || nominal.mode !== 'paper-only' || !nominal.evidence?.resultHash) throw new Error('verified nominal evaluation required');
  if (!Array.isArray(stressRuns) || stressRuns.length !== 4 || stressRuns.some((run) => !run?.evaluation?.ok)) {
    throw new Error('four valid stress evaluations required');
  }
  const nominalReturn = Number(nominal.metrics?.cumulativeReturnPct || 0);
  const rows = [{ id: 'nominal', label: 'Nominal', assumptions: { ...nominal.config }, evaluation: nominal }, ...stressRuns]
    .map(({ id, label, assumptions, evaluation }) => {
      const returnPct = Number(evaluation.metrics?.cumulativeReturnPct || 0);
      const maxDrawdownPct = Number(evaluation.metrics?.maxDrawdownPct || 0);
      const degradationPct = round(returnPct - nominalReturn, 4);
      const passed = maxDrawdownPct <= 25 && degradationPct >= -5;
      return {
        id, label, assumptions,
        metrics: { returnPct, maxDrawdownPct, sharpeLike: evaluation.metrics?.sharpeLike ?? null,
          totalCosts: evaluation.metrics?.totalCosts ?? null, trades: evaluation.metrics?.trades ?? 0, degradationPct },
        passed, resultHash: evaluation.evidence.resultHash,
      };
    });
  const passed = rows.filter((row) => row.passed).length;
  const worstDrawdownPct = Math.max(...rows.map((row) => row.metrics.maxDrawdownPct));
  const worstDegradationPct = Math.min(...rows.map((row) => row.metrics.degradationPct));
  const evidenceComplete = rows.every((row) => /^[a-f0-9]{64}$/.test(row.resultHash));
  const challengeCore = {
    version: AGENT_CHALLENGE_VERSION,
    mode: 'paper-only',
    status: evidenceComplete ? 'verified' : 'incomplete',
    decision: evidenceComplete && passed === rows.length ? 'resilient' : 'hold',
    reasonCode: evidenceComplete && passed === rows.length ? 'challenge-passed' : 'stress-threshold-failed',
    thresholds: { maximumDrawdownPct: 25, maximumReturnDegradationPct: 5, requiredScenarioPasses: rows.length },
    summary: { scenarioCount: rows.length, passed, failed: rows.length - passed, worstDrawdownPct, worstDegradationPct },
    scenarios: rows,
    guarantees: {
      deterministic: true, evidenceComplete, paperOnly: true, privateByDefault: true,
      automaticPromotion: false, executionAuthority: 'none', executionPermissionsChanged: false,
      liveScopeUsed: false, publicChainUsed: false,
    },
    caveat: 'Stress resilience is historical paper evidence, not a forecast or permission to trade.',
  };
  return { ...challengeCore, evidenceHash: hash(challengeCore) };
}

export function verifyAgentChallenge(challenge) {
  if (!challenge || challenge.version !== AGENT_CHALLENGE_VERSION || !/^[a-f0-9]{64}$/.test(challenge.evidenceHash || '')) return false;
  const { evidenceHash, ...core } = challenge;
  return hash(core) === evidenceHash
    && challenge.mode === 'paper-only'
    && challenge.status === 'verified'
    && challenge.guarantees?.evidenceComplete === true
    && challenge.guarantees?.privateByDefault === true
    && challenge.guarantees?.automaticPromotion === false
    && challenge.guarantees?.executionAuthority === 'none'
    && challenge.guarantees?.executionPermissionsChanged === false
    && challenge.summary?.scenarioCount === 5
    && Array.isArray(challenge.scenarios)
    && challenge.scenarios.length === 5
    && challenge.scenarios.every((scenario) => /^[a-f0-9]{64}$/.test(scenario.resultHash || ''));
}
