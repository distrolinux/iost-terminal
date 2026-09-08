import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSupervisedMissionRunner } from '../lib/supervised-mission-runner.js';
import { buildMcpTools } from '../lib/mcp-protocol.js';

const mission = {
  missionId: 'msn_runner123', name: 'Acceptance mission', symbols: ['IOST'], status: 'running',
  executionBoundary: 'PAPER_ONLY', liveTrading: false, approvalMode: 'per-order',
  authority: { canOpenPaperTrade: true }, startedAt: 100, expiresAt: 10_000,
  tradesOpened: 0, maxTrades: 1, events: [{ stage: 'system', type: 'started' }], positions: [],
};
const runtime = { runtimes: [{ status: 'ready', ready: true, checkpoint: { missionId: mission.missionId },
  supervisor: { managed: true, healthy: true }, quarantine: { active: false } }] };
const healthy = { missions: [mission], runtime, approvals: [], reconciliation: { decision: 'allow' },
  guardian: { coverage: { degraded: 0, unprotected: 0 } }, emergencyFreeze: { frozen: false }, now: 500 };

const observing = buildSupervisedMissionRunner(healthy);
assert.equal(observing.status, 'ready');
assert.equal(observing.currentStage, 'observe');
assert.equal(observing.nextAction.tool, 'market_snapshot');
assert.equal(observing.timeline.length, 6);
assert.equal(observing.execution.attempted, false);

const riskChecked = buildSupervisedMissionRunner({ ...healthy, missions: [{ ...mission, events: [{ stage: 'risk-check' }] }],
  approvals: [{ status: 'pending' }] });
assert.equal(riskChecked.status, 'awaiting-owner');
assert.equal(riskChecked.nextAction.actor, 'owner');
assert.equal(riskChecked.nextAction.tool, null);

const unprovenRiskCheck = buildSupervisedMissionRunner({ ...healthy,
  missions: [{ ...mission, events: [{ stage: 'risk-check' }] }] });
assert.equal(unprovenRiskCheck.currentStage, 'risk-check');
assert.equal(unprovenRiskCheck.nextAction.tool, 'paper_trade_preflight');

const ownerApproved = buildSupervisedMissionRunner({ ...healthy, approvals: [{ status: 'approved' }] });
assert.equal(ownerApproved.currentStage, 'execute');
assert.equal(ownerApproved.nextAction.tool, 'paper_trade_open');

const blocked = buildSupervisedMissionRunner({ ...healthy, reconciliation: { decision: 'deny' } });
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.reasonCode, 'execution-reconciled');
assert.equal(blocked.guarantees.automaticExecution, false);
assert.equal(blocked.liveScopeUsed, false);
assert.equal(blocked.publicChainUsed, false);

const tool = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] })
  .find((item) => item.name === 'paper_mission_runner_status');
assert(tool);
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(tool.annotations.destructiveHint, false);
assert.equal(tool.annotations.idempotentHint, true);
assert(!buildMcpTools().some((item) => item.name === 'paper_mission_runner_status'));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(server, /case 'paper_mission_runner_status'/);
assert.match(server, /missionRunner,/);
assert.match(server, /const DISCOVERY_VERSION = '1\.50\.0'/);
assert.match(app, /Supervised Paper Mission Runner/);
assert.match(app, /No action is executed by this panel/);

console.log('supervised paper mission runner checks passed');
