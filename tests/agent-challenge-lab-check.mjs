import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAgentStrategy, verifyEvaluationEvidence } from '../lib/evaluation.js';
import { verifyAgentChallenge } from '../lib/agent-challenge.js';

function candles(count = 300) {
  const rows = []; let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = Math.max(1, price + (i % 31 < 22 ? 0.48 : -0.38) + Math.sin(i / 4) * 0.17);
    rows.push({ ts: 1_700_000_000_000 + i * 86_400_000, o: open,
      h: Math.max(open, price) + 0.32, l: Math.min(open, price) - 0.32, c: price, v: 1_000 + i });
  }
  return rows;
}

const evaluation = evaluateAgentStrategy({
  symbol: 'IOST', timeframe: '1d', candles: candles(),
  strategy: { name: 'AITT challenge fixture', side: 'long', sizePct: 0.4,
    entry: { rule: 'breakout', params: { lookback: 8 } },
    exit: { stopPct: 0.025, targetPct: 0.05, maxBars: 12 } },
  config: { trainBars: 80, testBars: 40, stepBars: 40, minimumTrades: 1,
    costs: { feeBps: 10, spreadBps: 8, slippageBps: 6 } },
});

assert.equal(evaluation.ok, true);
const challenge = evaluation.challenge;
assert.equal(challenge.version, 1);
assert.equal(challenge.mode, 'paper-only');
assert.equal(challenge.status, 'verified');
assert.deepEqual(challenge.scenarios.map((row) => row.id),
  ['nominal', 'fee-shock', 'thin-book', 'delayed-fill', 'combined-stress']);
assert.equal(challenge.summary.scenarioCount, 5);
assert.equal(challenge.thresholds.requiredScenarioPasses, 5);
assert.equal(challenge.guarantees.deterministic, true);
assert.equal(challenge.guarantees.privateByDefault, true);
assert.equal(challenge.guarantees.automaticPromotion, false);
assert.equal(challenge.guarantees.executionAuthority, 'none');
assert.equal(challenge.guarantees.liveScopeUsed, false);
assert.equal(challenge.guarantees.publicChainUsed, false);
assert.equal(verifyAgentChallenge(challenge), true);
assert.equal(verifyEvaluationEvidence(evaluation), true);

const replay = evaluateAgentStrategy({
  symbol: 'IOST', timeframe: '1d', candles: candles(), strategy: evaluation.strategy, config: evaluation.config,
});
assert.equal(replay.challenge.evidenceHash, challenge.evidenceHash, 'challenge evidence must be deterministic');
assert.deepEqual(replay.challenge.scenarios, challenge.scenarios);
assert.equal(verifyAgentChallenge({ ...challenge, decision: challenge.decision === 'hold' ? 'resilient' : 'hold' }), false);
assert.equal(verifyAgentChallenge({ ...challenge, scenarios: challenge.scenarios.slice(1) }), false);

const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(protocol, /readTool\('agent_challenge_scorecards'/);
assert.match(server, /case 'agent_challenge_scorecards'/);
assert.match(server, /app\.get\('\/api\/agent-challenges', requireUser/);
assert.match(app, /AITT AGENT CHALLENGE LAB/);

console.log('AITT Agent Challenge Lab deterministic stress, integrity and safety checks passed');
