// Read-only, deterministic workflow composer for supervised paper missions.
// It never calls a tool, reserves funds, approves an order, or executes a trade.

export const SUPERVISED_MISSION_RUNNER_VERSION = 1;

const PIPELINE = Object.freeze([
  { stage: 'observe', title: 'Observe', tool: 'market_snapshot' },
  { stage: 'analyze', title: 'Analyze', tool: 'analyze_symbol' },
  { stage: 'risk-check', title: 'Preflight', tool: 'paper_trade_preflight' },
  { stage: 'execute', title: 'Execute', tool: 'paper_trade_open' },
  { stage: 'verify', title: 'Verify', tool: 'paper_execution_receipts' },
  { stage: 'journal', title: 'Journal', tool: 'paper_mission_checkpoint' },
]);

const latestEvent = (mission) => Array.isArray(mission?.events) ? mission.events.at(-1) : null;
const missionAuthorized = (mission) => {
  const authority = mission?.authority;
  if (authority) return authority.canOpenPaperTrade === true;
  return mission?.status === 'running';
};

function matchingRuntime(runtime, missionId) {
  const candidates = Array.isArray(runtime?.runtimes) ? runtime.runtimes : runtime ? [runtime] : [];
  return candidates.find((item) => item?.checkpoint?.missionId === missionId) || null;
}

function workflowStage(mission, approvals) {
  if ((mission?.positions || []).length > 0) return 'verify';
  if (approvals.some((item) => item?.status === 'approved')) return 'execute';
  if (approvals.some((item) => item?.status === 'pending')) return 'approval';
  const stage = latestEvent(mission)?.stage;
  if (!stage || stage === 'system' || stage === 'journal') return 'observe';
  if (stage === 'observe') return 'analyze';
  if (stage === 'analyze') return 'risk-check';
  // A free-form checkpoint is not proof that preflight allowed execution.
  // Only a durable approval record may advance a per-order mission beyond risk-check.
  if (stage === 'risk-check') return 'risk-check';
  if (stage === 'execute') return 'verify';
  if (stage === 'verify') return 'journal';
  return 'observe';
}

export function buildSupervisedMissionRunner({
  missions = [], runtime = null, approvals = [], reconciliation = null,
  guardian = null, emergencyFreeze = null, missionId = null, now = Date.now(),
} = {}) {
  const eligible = (Array.isArray(missions) ? missions : []).filter((mission) => mission?.status === 'running');
  const mission = missionId
    ? eligible.find((item) => item.missionId === missionId) || null
    : eligible.sort((a, b) => Number(b.startedAt || b.createdAt || 0) - Number(a.startedAt || a.createdAt || 0))[0] || null;
  const boundRuntime = mission ? matchingRuntime(runtime, mission.missionId) : null;
  const coverage = guardian?.coverage || guardian || {};
  const checks = [
    { code: 'running-mission', pass: !!mission },
    { code: 'paper-boundary', pass: !!mission && mission.executionBoundary === 'PAPER_ONLY' && mission.liveTrading !== true },
    { code: 'mission-authorized', pass: !!mission && missionAuthorized(mission) },
    { code: 'runtime-mission-bound', pass: !!boundRuntime },
    { code: 'runtime-ready', pass: boundRuntime?.ready === true && boundRuntime?.status === 'ready' },
    { code: 'runtime-supervised', pass: boundRuntime?.supervisor?.managed === true && boundRuntime?.supervisor?.healthy === true },
    { code: 'runtime-not-quarantined', pass: boundRuntime?.quarantine?.active !== true },
    { code: 'execution-reconciled', pass: reconciliation?.decision === 'allow' },
    { code: 'position-guardian-healthy', pass: Number(coverage.degraded || 0) === 0 && Number(coverage.unprotected || 0) === 0 },
    { code: 'emergency-freeze-clear', pass: emergencyFreeze?.frozen !== true },
  ];
  const failure = checks.find((check) => !check.pass) || null;
  const stage = mission ? workflowStage(mission, Array.isArray(approvals) ? approvals : []) : 'idle';
  const ownerActionRequired = stage === 'approval';
  const currentIndex = PIPELINE.findIndex((item) => item.stage === stage);
  const timeline = PIPELINE.map((item, index) => ({
    ...item,
    status: stage === 'approval' && item.stage === 'execute' ? 'waiting'
      : index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming',
  }));
  const next = ownerActionRequired
    ? { code: 'owner-approval', actor: 'owner', tool: null, mutation: false,
      description: 'Review the exact short-lived paper mandate in Owner Approval Queue.' }
    : PIPELINE.find((item) => item.stage === stage) || null;
  const status = !mission ? 'idle' : failure ? 'blocked' : ownerActionRequired ? 'awaiting-owner' : 'ready';
  return {
    ok: true,
    mode: 'paper-only',
    version: SUPERVISED_MISSION_RUNNER_VERSION,
    status,
    decision: failure ? 'hold' : 'continue',
    reasonCode: !mission ? 'no-running-mission' : failure?.code || (ownerActionRequired ? 'owner-approval-required' : 'next-action-ready'),
    mission: mission ? {
      missionId: mission.missionId,
      name: mission.name,
      symbols: [...(mission.symbols || [])],
      approvalMode: mission.approvalMode,
      expiresAt: mission.expiresAt,
      tradesOpened: Number(mission.tradesOpened ?? mission.usage?.tradesOpened ?? 0),
      maximumTrades: Number(mission.maxTrades ?? mission.limits?.maximumTrades ?? 0),
    } : null,
    currentStage: stage,
    nextAction: next ? {
      code: next.code || next.stage,
      actor: next.actor || 'agent',
      tool: next.tool || null,
      mutation: next.stage === 'execute' || next.stage === 'journal',
      ownerApprovalRequired: ownerActionRequired,
      description: next.description || (next.stage === 'risk-check' && mission?.approvalMode === 'per-order'
        ? 'Run a fresh read-only preflight; if allowed, create an exact short-lived owner approval request.'
        : `${next.title} using the existing guarded ${next.tool} contract.`),
    } : null,
    timeline,
    checks,
    runtime: {
      missionBound: !!boundRuntime,
      ready: boundRuntime?.ready === true,
      supervised: boundRuntime?.supervisor?.managed === true && boundRuntime?.supervisor?.healthy === true,
      checkpointPresent: !!boundRuntime?.checkpoint,
    },
    generatedAt: Math.trunc(now),
    guarantees: {
      readOnly: true,
      deterministic: true,
      existingToolBoundariesPreserved: true,
      ownerApprovalPreserved: true,
      automaticExecution: false,
      authorityExpanded: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}
