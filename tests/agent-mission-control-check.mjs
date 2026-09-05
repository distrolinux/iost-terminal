import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-missions-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const wallets = await import('../lib/wallets.js');
  const pacts = await import('../lib/pacts.js');
  const missions = await import('../lib/missions.js');

  const ownerId = 'user:mission-owner';
  const otherOwnerId = 'user:outsider';
  const wallet = wallets.createAgentWallet({
    ownerId,
    name: 'Mission paper wallet',
    capabilities: ['trade.paper'],
    limits: { USD: { maxPerTxMinor: 2_500, dailyCapMinor: 10_000, weeklyCapMinor: 50_000 } },
    approvalRequired: true,
  });
  const pact = pacts.proposePact({
    ownerId,
    agentWalletId: wallet.walletId,
    intent: 'Bounded mission paper trading',
    policies: { approvalRequired: true, limits: { maxPerTxMinor: 2_500 } },
    completion: { type: 'time', deadlineTs: Date.now() + 86_400_000 },
  });
  pacts.approvePact(pact.pactId, ownerId);

  assert.throws(() => missions.createMission({
    ownerId, walletId: wallet.walletId, pactId: pact.pactId, name: 'Oversized mission',
    symbols: ['IOST'], maxOrderMinor: 2_501, maxTrades: 1, maxLossMinor: 100,
    approvalMode: 'within-pact', expiresAt: Date.now() + 3_600_000,
  }), /exceeds wallet limit/);

  assert.throws(() => missions.createMission({
    ownerId: otherOwnerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    name: 'Stolen authority',
    symbols: ['IOST'],
    expiresAt: Date.now() + 3_600_000,
  }), /wallet does not belong to owner/);

  const mission = missions.createMission({
    ownerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    name: 'IOST observation mission',
    objective: 'Find risk-adjusted paper entries with evidence.',
    strategy: 'Score and risk-gated momentum',
    symbols: ['iost', 'btc'],
    maxOrderMinor: 2_000,
    maxTrades: 2,
    maxLossMinor: 1_000,
    approvalMode: 'within-pact',
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(mission.status, 'paused');
  assert.deepEqual(mission.symbols, ['IOST', 'BTC']);
  assert.equal(mission.executionBoundary, 'PAPER_ONLY');
  assert.equal(mission.liveTrading, false);

  const pausedEvidence = missions.missionEvidence(mission);
  assert.deepEqual(pausedEvidence.symbols, ['IOST', 'BTC']);
  assert.deepEqual(pausedEvidence.limits, {
    currency: 'USD', maximumOrderMinor: 2_000, maximumOrderUsd: '20.00',
    realizedLossHaltMinor: 1_000, realizedLossHaltUsd: '10.00', maximumTrades: 2,
  });
  assert.equal(pausedEvidence.usage.tradesOpened, 0);
  assert.equal(pausedEvidence.authority.exactWalletPactBinding, true);
  assert.equal(pausedEvidence.authority.paperOnly, true);
  assert.equal(pausedEvidence.authority.tradeLive, false);
  assert.equal(pausedEvidence.authority.canOpenPaperTrade, false, 'paused mission cannot execute');
  assert.equal('walletId' in pausedEvidence, false);
  assert.equal('pactId' in pausedEvidence, false);
  assert.equal('ownerId' in pausedEvidence, false);
  const serializedEvidence = JSON.stringify(pausedEvidence);
  assert.equal(serializedEvidence.includes(wallet.walletId), false);
  assert.equal(serializedEvidence.includes(pact.pactId), false);

  const started = missions.startMission(mission.missionId, ownerId);
  assert.equal(started.status, 'running');
  assert.equal(missions.missionEvidence(started).authority.canOpenPaperTrade, true);

  const approvalMission = missions.createMission({
    ownerId, walletId: wallet.walletId, pactId: pact.pactId, name: 'Owner approval mission',
    symbols: ['IOST'], maxOrderMinor: 2_000, maxTrades: 1, maxLossMinor: 500,
    approvalMode: 'per-order', expiresAt: Date.now() + 3_600_000,
  });
  missions.startMission(approvalMission.missionId, ownerId);
  const approvalInput = { missionId: approvalMission.missionId, ownerId, walletId: wallet.walletId,
    pactId: pact.pactId, symbol: 'IOST', notionalMinor: 500 };
  assert.equal(missions.previewMissionTrade(approvalInput).ok, true, 'preflight must be possible before owner approval');
  assert.equal(missions.previewMissionTrade(approvalInput).approvalRequired, true);
  assert.equal(missions.checkMissionTrade(approvalInput).reason, 'mission-approval-required');
  assert.equal(missions.checkMissionTrade({ ...approvalInput, approvalAuthorized: true }).ok, true);
  assert.deepEqual(missions.missionApprovalRequirement(approvalMission.missionId, ownerId), {
    required: true, mode: 'per-order', reasons: ['per-order-policy'],
  });

  assert.equal(missions.checkMissionTrade({
    missionId: mission.missionId,
    ownerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    symbol: 'ETH',
    notionalMinor: 1_000,
  }).reason, 'symbol-not-allowed');
  assert.equal(missions.checkMissionTrade({
    missionId: mission.missionId,
    ownerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    symbol: 'IOST',
    notionalMinor: 2_001,
  }).reason, 'mission-order-cap');
  assert.equal(missions.checkMissionTrade({
    missionId: mission.missionId,
    ownerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    symbol: 'IOST',
    notionalMinor: 1_500,
  }).ok, true);

  missions.recordMissionTrade(mission.missionId, ownerId, { positionId: 'paper-1', symbol: 'IOST', notionalMinor: 1_500 });
  missions.recordMissionCheckpoint(mission.missionId, ownerId, { stage: 'verify', detail: 'Paper fill verified', latencyMs: 42 });
  missions.recordMissionTrade(mission.missionId, ownerId, { positionId: 'paper-2', symbol: 'BTC', notionalMinor: 500 });
  assert.equal(missions.checkMissionTrade({
    missionId: mission.missionId,
    ownerId,
    walletId: wallet.walletId,
    pactId: pact.pactId,
    symbol: 'IOST',
    notionalMinor: 100,
  }).reason, 'mission-trade-cap');

  const lossHalt = missions.recordMissionClose('paper-1', ownerId, -1_000);
  assert.equal(lossHalt.status, 'paused');
  assert.equal(lossHalt.events.at(-1).type, 'loss-halt');

  const stopped = missions.stopMission(mission.missionId, ownerId, 'operator stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(missions.getMission(mission.missionId, otherOwnerId), null);
  assert.equal(missions.getMission(mission.missionId, ownerId).events.some((event) => event.stage === 'verify'), true);

  const reservedMission = missions.createMission({
    ownerId, walletId: wallet.walletId, pactId: pact.pactId, name: 'Reservation mission',
    symbols: ['IOST'], maxOrderMinor: 1_000, maxTrades: 1, maxLossMinor: 100,
    approvalMode: 'within-pact', expiresAt: Date.now() + 3_600_000,
  });
  missions.startMission(reservedMission.missionId, ownerId);
  const firstReservation = missions.reserveMissionTrade({ missionId: reservedMission.missionId, ownerId, walletId: wallet.walletId, pactId: pact.pactId, symbol: 'IOST', notionalMinor: 500 });
  assert.equal(firstReservation.ok, true);
  assert.equal(missions.reserveMissionTrade({ missionId: reservedMission.missionId, ownerId, walletId: wallet.walletId, pactId: pact.pactId, symbol: 'IOST', notionalMinor: 500 }).reason, 'mission-trade-cap');
  assert.equal(missions.releaseMissionTrade(reservedMission.missionId, ownerId, firstReservation.reservationId).ok, true);
  pacts.terminatePact(pact.pactId, ownerId);
  const inactiveAuthority = missions.missionEvidence(missions.getMission(reservedMission.missionId, ownerId)).authority;
  assert.equal(inactiveAuthority.exactWalletPactBinding, true, 'historical exact binding remains attestable');
  assert.equal(inactiveAuthority.pactActive, false);
  assert.equal(inactiveAuthority.canOpenPaperTrade, false, 'inactive Pact must fail closed');

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/agent-missions',\s*requireUser/);
  assert.match(server, /app\.post\('\/api\/agent-missions',\s*requireUser/);
  assert.match(server, /agent-missions[\s\S]{0,1000}isOwnerSession\(req\)/);
  assert.match(server, /reserveMissionTrade\(/, 'mission trade envelope must be reserved before execution');
  assert.match(server, /commitMissionTrade\(/, 'accepted mission paper trades must be attached to their mission');
  assert.match(server, /listMissionEvidence\(ownerId\)/, 'MCP mission reads must use sanitized evidence');
  assert.match(server, /missionEvidence\(missions\.recordMissionCheckpoint/, 'MCP checkpoints must not return raw authority identifiers');
  const management = readFileSync(new URL('../lib/management.js', import.meta.url), 'utf8');
  assert.match(management, /recordMissionClose\(/, 'automatic paper exits must feed mission loss limits');
  assert.match(app, /Mission Control/);
  assert.match(app, /Observe[\s\S]{0,300}Analyze[\s\S]{0,300}Risk check[\s\S]{0,300}Execute[\s\S]{0,300}Verify[\s\S]{0,300}Journal/);
  assert.match(app, /data-mission-action="stop"/);
  assert.match(css, /\.mission-pipeline/);

  console.log('agent mission control checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
