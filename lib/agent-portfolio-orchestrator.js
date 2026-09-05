// Central paper-execution arbiter. Every account gets one in-process writer.
// Risk-reducing closes move ahead of queued opens without interrupting an
// operation already in flight. Durable intent/receipt reconciliation remains
// the recovery authority across process restarts.

const MAX_QUEUE_DEPTH = 64;
const lanes = new Map();

const cleanAction = (value) => value === 'close' ? 'close' : 'open';

function laneFor(accountId) {
  const key = String(accountId || '').trim();
  if (!key) throw new Error('paper account required for portfolio orchestration');
  if (!lanes.has(key)) lanes.set(key, { active: null, queue: [] });
  return { key, lane: lanes.get(key) };
}

function drain(key, lane) {
  if (lane.active || !lane.queue.length) {
    if (!lane.active && !lane.queue.length) lanes.delete(key);
    return;
  }
  const next = lane.queue.shift();
  lane.active = { action: next.action, startedAt: Date.now() };
  Promise.resolve().then(next.operation).then(next.resolve, next.reject).finally(() => {
    lane.active = null;
    drain(key, lane);
  });
}

export function runPortfolioExecution({ accountId, action = 'open' } = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('portfolio operation must be a function');
  const { key, lane } = laneFor(accountId);
  if (lane.queue.length >= MAX_QUEUE_DEPTH) {
    const error = new Error('portfolio execution queue is at capacity');
    error.status = 503;
    error.reason = 'portfolio-orchestrator-capacity';
    throw error;
  }
  const normalizedAction = cleanAction(action);
  return new Promise((resolve, reject) => {
    const entry = { action: normalizedAction, operation, resolve, reject };
    if (normalizedAction === 'close') {
      const firstOpen = lane.queue.findIndex((item) => item.action === 'open');
      if (firstOpen === -1) lane.queue.push(entry);
      else lane.queue.splice(firstOpen, 0, entry);
    } else lane.queue.push(entry);
    drain(key, lane);
  });
}

export function portfolioExecutionLaneStatus(accountId) {
  const lane = lanes.get(String(accountId || '').trim());
  const queued = lane?.queue || [];
  return {
    active: !!lane?.active,
    activeAction: lane?.active?.action || null,
    activeAgeMs: lane?.active?.startedAt ? Math.max(0, Date.now() - lane.active.startedAt) : null,
    queued: queued.length,
    queuedOpens: queued.filter((item) => item.action === 'open').length,
    queuedCloses: queued.filter((item) => item.action === 'close').length,
    maximumQueueDepth: MAX_QUEUE_DEPTH,
  };
}

function normalizedPositions(account) {
  return Array.isArray(account?.positions) ? account.positions : [];
}

export function buildAgentPortfolioOrchestrator({
  account = {}, missions = [], keys = [], runtimes = null, reconciliation = null, lane = null,
} = {}) {
  const positions = normalizedPositions(account);
  const exposure = new Map();
  for (const position of positions) {
    const symbol = String(position?.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const sides = exposure.get(symbol) || new Set();
    sides.add(position?.side === 'short' ? 'short' : 'long');
    exposure.set(symbol, sides);
  }
  const opposingSymbols = [...exposure.entries()].filter(([, sides]) => sides.size > 1).map(([symbol]) => symbol).sort();
  const running = (Array.isArray(missions) ? missions : []).filter((mission) => mission?.status === 'running');
  const mandates = new Map();
  for (const mission of running) {
    for (const raw of mission.symbols || []) {
      const symbol = String(raw || '').trim().toUpperCase();
      if (!symbol) continue;
      const wallets = mandates.get(symbol) || new Set();
      wallets.add(String(mission.walletId || 'unknown'));
      mandates.set(symbol, wallets);
    }
  }
  const overlappingMandates = [...mandates.entries()].filter(([, owners]) => owners.size > 1)
    .map(([symbol, owners]) => ({ symbol, agentCount: owners.size, severity: 'advisory' }));
  const keyRows = Array.isArray(keys) ? keys : [];
  const runtimeRows = Array.isArray(runtimes?.runtimes) ? runtimes.runtimes : [];
  const reconciliationHealthy = reconciliation?.decision === 'allow';
  const laneStatus = lane || portfolioExecutionLaneStatus(account?.accountId);
  const critical = [
    ...opposingSymbols.map((symbol) => ({ code: 'opposing-symbol-exposure', symbol, severity: 'critical' })),
    ...(reconciliationHealthy ? [] : [{ code: reconciliation?.reasonCode || 'execution-reconciliation-required', severity: 'critical' }]),
  ];
  return {
    ok: true,
    mode: 'paper-only',
    version: 1,
    status: critical.length ? 'blocked' : overlappingMandates.length ? 'attention' : 'healthy',
    decision: critical.length ? 'deny' : 'allow',
    reasonCode: critical[0]?.code || (overlappingMandates.length ? 'overlapping-mandates-observed' : 'portfolio-coordination-clear'),
    counts: {
      activeAgents: keyRows.filter((key) => key?.status === 'active').length,
      paperTradingAgents: keyRows.filter((key) => key?.status === 'active' && (key.scopes || []).includes('trade-paper')).length,
      readyRuntimes: runtimeRows.filter((runtime) => runtime?.ready === true).length,
      runningMissions: running.length,
      positions: positions.length,
      exposedSymbols: exposure.size,
      opposingExposureConflicts: opposingSymbols.length,
      overlappingMandates: overlappingMandates.length,
    },
    executionLane: { ...laneStatus, policy: 'single-writer-per-account', closePriority: true },
    conflicts: [...critical, ...overlappingMandates.map((item) => ({ code: 'overlapping-agent-mandate', ...item }))],
    policy: {
      centralArbiter: true,
      deterministic: true,
      capabilityBoundRouting: true,
      automaticAgentSubstitution: false,
      fallbackRequiresOwnerApproval: true,
      priority: ['risk-reducing-close', 'fifo-new-exposure'],
      opposingSymbolExposure: 'fail-closed-for-agent-opens',
      restartRecoveryAuthority: 'execution-intent-and-receipt-reconciliation',
    },
    guarantees: {
      onePaperWriterPerAccount: true,
      idempotencyPreserved: true,
      ownerIsolation: true,
      authorityExpanded: false,
      executionPermissionsChanged: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

