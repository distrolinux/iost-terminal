// Deterministic owner guidance assembled from existing authoritative safety
// evidence. This module never performs an action or expands authority.

export const OWNER_ACTION_WORKBENCH_VERSION = 1;
export const OWNER_ACTION_RECOVERY_PROBATION_MS = 30 * 60_000;

const item = (code, title, detail, state, target, action = null) => ({
  code, title, detail, state, target, action,
});

export function buildOwnerActionWorkbench({
  incidents = {}, runtime = {}, safetySlo = {}, guardian = {}, dataTrust = {},
  reconciliation = {}, authorization = false, wallets = [], pacts = [], missions = [],
  frozen = false, now = Date.now(),
} = {}) {
  const incidentList = Array.isArray(incidents.incidents) ? incidents.incidents : [];
  const openIncidents = incidentList.filter((incident) => incident.status !== 'resolved');
  const lastResolvedAt = incidentList.reduce((latest, incident) => (
    incident.status === 'resolved' && Number.isFinite(Number(incident.resolvedAt))
      ? Math.max(latest, Number(incident.resolvedAt)) : latest
  ), 0);
  const recoveryAgeMs = lastResolvedAt ? Math.max(0, Math.trunc(now) - lastResolvedAt) : null;
  const probationRemainingMs = recoveryAgeMs == null
    ? 0 : Math.max(0, OWNER_ACTION_RECOVERY_PROBATION_MS - recoveryAgeMs);
  const runtimes = Array.isArray(runtime.runtimes) ? runtime.runtimes : [];
  const readyRuntime = runtimes.find((entry) => entry.ready && entry.supervisor?.managed
    && entry.supervisor?.healthy && entry.checkpoint && entry.quarantine?.active !== true) || null;
  const blockingBurns = (safetySlo.burnRates || []).filter((burn) => (
    ['fast', 'slow'].includes(burn?.name) && burn?.firing === true
  ));
  const coverage = guardian.coverage || {};
  const activeWallet = wallets.find((wallet) => wallet.status === 'active'
    && wallet.capabilities?.includes('trade.paper')) || null;
  const activePact = activeWallet ? pacts.find((pact) => pact.status === 'active'
    && pact.agentWalletId === activeWallet.walletId) : null;
  const runningMission = activeWallet && activePact ? missions.find((mission) => (
    mission.status === 'running' && mission.walletId === activeWallet.walletId
    && mission.pactId === activePact.pactId
  )) : null;
  const missionBound = Boolean(runningMission && readyRuntime?.checkpoint?.missionId === runningMission.missionId);
  const actions = [];

  for (const incident of openIncidents) {
    const acknowledged = Boolean(incident.acknowledgedAt);
    if (incident.recoveryReady && !acknowledged) {
      actions.push(item('incident-acknowledge', 'Review the recovered incident',
        'Confirm that the supervised runtime is healthy before acknowledging this incident.',
        'owner-action', { view: 'control', anchor: 'incidentRecoveryTitle' },
        { kind: 'incident', operation: 'acknowledge', incidentRef: incident.incidentRef, requiresConfirmation: true }));
    } else if (incident.recoveryReady && acknowledged) {
      actions.push(item('incident-resolve', 'Release the recovered incident',
        'Resolve the reviewed incident and release only its runtime quarantine.',
        'owner-action', { view: 'control', anchor: 'incidentRecoveryTitle' },
        { kind: 'incident', operation: 'resolve', incidentRef: incident.incidentRef, requiresConfirmation: true }));
    } else {
      actions.push(item('incident-recovery', 'Wait for supervised runtime recovery',
        'Owner release remains locked until the runtime is healthy and recovery-ready.',
        'waiting', { view: 'control', anchor: 'runtimeReliabilityTitle' }));
    }
  }
  if (!readyRuntime) actions.push(item('runtime-ready', 'Restore the supervised runtime',
    'Start or recover the runtime supervisor from its exact durable checkpoint.',
    'system-action', { view: 'control', anchor: 'runtimeReliabilityTitle' }));
  if (!openIncidents.length && probationRemainingMs > 0) actions.push(item('recovery-probation', 'Recovery probation is active',
    `Continue healthy supervision for ${Math.ceil(probationRemainingMs / 60_000)} more minute(s).`,
    'waiting', { view: 'control', anchor: 'safetySloTitle' }));
  if (blockingBurns.length) actions.push(item('safety-burn', 'Safety burn rate must clear',
    `${blockingBurns.map((burn) => burn.name).join(' and ')} operational burn evidence is still firing.`,
    'waiting', { view: 'control', anchor: 'safetySloTitle' }));
  if (Number(coverage.degraded || 0) || Number(coverage.unprotected || 0)) actions.push(item('position-protection',
    'Review Position Guardian coverage', 'New exposure stays blocked while any position is degraded or unprotected.',
    'system-action', { view: 'control', anchor: 'executionReadinessTitle' }));
  if (dataTrust.decision !== 'allow') actions.push(item('data-trust', 'Restore trusted market evidence',
    'Fresh structured evidence must pass the Data Trust Firewall.', 'system-action',
    { view: 'control', anchor: 'dataTrustTitle' }));
  if (reconciliation.decision !== 'allow') actions.push(item('reconciliation', 'Reconcile execution state',
    'Resolve ledger contradictions before any new exposure.', 'system-action',
    { view: 'control', anchor: 'executionReconciliationTitle' }));
  if (frozen) actions.push(item('emergency-freeze', 'Emergency freeze is active',
    'Keep execution blocked until the owner completes an independent safety review.', 'owner-action',
    { view: 'control', anchor: 'executionReadinessTitle' }));
  if (!activeWallet) actions.push(item('paper-wallet', 'Create or reactivate a paper wallet',
    'Use a bounded simulation balance with trade.paper only.', 'owner-action',
    { view: 'launchpad', anchor: 'launchpadSetupTitle' }));
  else if (!activePact || !authorization) actions.push(item('paper-pact', 'Approve a wallet-bound paper Pact',
    'Create or activate a time-limited Pact for this exact paper wallet; do not grant live scope.',
    'owner-action', { view: 'launchpad', anchor: 'launchpadPactTitle' }));
  else if (!runningMission) actions.push(item('paper-mission', 'Start a supervised paper mission',
    'Create a narrow mission bound to the active wallet and Pact.', 'owner-action',
    { view: 'control', anchor: 'missionControlTitle' }));
  else if (!missionBound) actions.push(item('mission-binding', 'Bind the runtime checkpoint to the mission',
    'Update the supervisor context, then allow its next heartbeat to establish the exact mission binding.',
    'system-action', { view: 'control', anchor: 'runtimeReliabilityTitle' }));

  if (!actions.length) actions.push(item('ready', 'Ready for a fresh paper preflight',
    'All observed owner, runtime, safety and authorization prerequisites are clear.',
    'complete', { view: 'control', anchor: 'executionReadinessTitle' }));
  const next = actions.find((entry) => entry.state === 'owner-action')
    || actions.find((entry) => entry.state === 'system-action')
    || actions.find((entry) => entry.state === 'waiting') || actions[0];
  return {
    ok: true, mode: 'paper-only', version: OWNER_ACTION_WORKBENCH_VERSION,
    status: actions.every((entry) => entry.state === 'complete') ? 'ready' : 'action-required',
    nextAction: next, actions,
    counts: {
      ownerAction: actions.filter((entry) => entry.state === 'owner-action').length,
      systemAction: actions.filter((entry) => entry.state === 'system-action').length,
      waiting: actions.filter((entry) => entry.state === 'waiting').length,
    },
    evidence: { openIncidents: openIncidents.length, supervisedRuntimeReady: Boolean(readyRuntime),
      recoveryProbationRemainingMs: probationRemainingMs, walletPactAuthorized: Boolean(activeWallet && activePact && authorization),
      missionBound },
    guarantees: { readOnlyPlan: true, deterministic: true, ownerApprovalPreserved: true,
      noAutomaticOwnerActions: true, authorityExpanded: false, executionPermissionsChanged: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false, publicChainUsed: false,
  };
}
