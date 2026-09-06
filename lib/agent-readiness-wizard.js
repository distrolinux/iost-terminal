// Deterministic owner guidance for reaching supervised paper preflight.
// This module observes existing authority and safety evidence only. It never
// creates wallets, keys, Pacts, missions, sessions, reservations, or trades.

const step = (code, label, detail, pass, target) => ({ code, label, detail, pass: Boolean(pass), target });

export function buildAgentReadinessWizard({ wallets = [], pacts = [], keys = [], runtime = {}, missions = [],
  incidents = {}, safetySlo = {}, guardian = {}, sessionSecurity = {}, releaseTrust = {}, frozen = false } = {}) {
  const wallet = wallets.find((item) => item.status === 'active' && item.capabilities?.includes('trade.paper')) || null;
  const pact = wallet ? pacts.find((item) => item.status === 'active' && item.agentWalletId === wallet.walletId) : null;
  const paperKeys = keys.filter((item) => !item.revokedAt && item.scopes?.includes('read') && item.scopes?.includes('trade-paper'));
  const connected = paperKeys.some((item) => item.lastUsedAt) || (sessionSecurity.sessions || []).some((item) =>
    item.status === 'active' && item.resource === 'mcp'
    && item.scopes?.includes('read') && item.scopes?.includes('trade-paper'));
  const readyRuntime = (runtime.runtimes || []).find((item) => item.ready && item.supervisor?.managed
    && item.supervisor?.healthy && item.checkpoint && item.quarantine?.active !== true
    && item.execution?.newMissionExposureAllowed) || null;
  const runningMission = wallet && pact ? missions.find((item) => item.status === 'running'
    && item.walletId === wallet.walletId && item.pactId === pact.pactId) : null;
  const missionBound = Boolean(runningMission && readyRuntime?.checkpoint?.missionId === runningMission.missionId);
  const incidentClear = Number(incidents.counts?.open || 0) === 0 && Number(incidents.counts?.critical || 0) === 0;
  const burnRates = Array.isArray(safetySlo.burnRates)
    ? safetySlo.burnRates
    : Object.entries(safetySlo.burnRates || {}).map(([name, evidence]) => ({ name, ...evidence }));
  const blockingBurns = burnRates.filter((burn) => ['fast', 'slow'].includes(burn?.name));
  const burnEvidenceComplete = ['fast', 'slow'].every((name) => blockingBurns.some((burn) => (
    burn.name === name && typeof burn.firing === 'boolean'
  )));
  const burnClear = burnEvidenceComplete && !blockingBurns.some((burn) => burn.firing);
  const guardianClear = !guardian.coverage?.degraded && !guardian.coverage?.unprotected;
  const safetyClear = incidentClear && burnClear && guardianClear && !frozen && releaseTrust.status === 'verified';
  const steps = [
    step('budget', 'Safety budget', wallet ? 'Active paper wallet with bounded simulation funds' : 'Create or reactivate a paper-only wallet', wallet, 'setup'),
    step('permission', 'Owner permission', pact ? 'Active Pact is bound to this exact wallet' : 'Review or replace the wallet-bound Pact', pact, 'pact'),
    step('access', 'Scoped access', paperKeys.length ? 'Revocable read + trade-paper credential exists' : 'Create a least-privilege paper credential', paperKeys.length, 'key'),
    step('connection', 'Connected client', connected ? 'Authenticated agent activity has been observed' : 'Connect the credential through a secret manager', connected, 'connect'),
    step('runtime', 'Supervised runtime', readyRuntime ? 'Healthy supervisor and durable checkpoint present' : 'Start or recover the runtime supervisor', readyRuntime, 'control'),
    step('mission', 'Bound mission', missionBound ? 'Running mission matches the runtime checkpoint' : 'Start and bind a supervised paper mission', missionBound, 'control'),
    step('safety', 'Safety gate', safetyClear ? 'Incidents, burn rates, guardian and release trust are clear' : 'Review the exact safety blockers before preflight', safetyClear, 'control'),
  ];
  const completed = steps.filter((item) => item.pass).length;
  const next = steps.find((item) => !item.pass) || null;
  return {
    ok: true, mode: 'paper-only', version: 1,
    status: next ? 'action-required' : 'ready-for-preflight',
    progress: { completed, total: steps.length, percent: Math.round(completed / steps.length * 100) },
    steps,
    nextAction: next ? { code: next.code, label: next.detail, target: next.target } : {
      code: 'preflight', label: 'Run a fresh read-only preflight', target: 'control',
    },
    evidence: { walletPactBound: Boolean(wallet && pact), connected, supervisedRuntimeReady: Boolean(readyRuntime),
      missionBound, incidentClear, burnClear, guardianClear, emergencyFreezeInactive: !frozen,
      releaseVerified: releaseTrust.status === 'verified' },
    guarantees: { advisoryOnly: true, deterministic: true, ownerApprovalPreserved: true,
      authorityExpanded: false, executionPermissionsChanged: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}
