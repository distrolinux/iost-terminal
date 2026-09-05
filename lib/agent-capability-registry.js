// Agent capability and delegation registry.
//
// This module deliberately stores no grants. Effective authority is derived
// from independent server-owned facts: an owner-created credential, its
// scopes, supervised runtime health, and an active wallet-bound Pact. Agent
// names, prompts and self-declared skills are never authorization evidence.

const READ_CAPABILITIES = Object.freeze([
  'market.observe', 'portfolio.inspect', 'risk.assess', 'strategy.analyze',
]);
const PAPER_CAPABILITIES = Object.freeze(['paper.preflight', 'paper.execute']);

const active = (value) => value?.status === 'active';

function runtimeReady(runtime) {
  return runtime?.enrolled === true
    && runtime?.ready === true
    && runtime?.status === 'ready'
    && runtime?.supervisor?.managed === true
    && runtime?.supervisor?.healthy === true
    && runtime?.quarantine?.active !== true;
}

function activeBindings(wallets, pacts, now) {
  const paperWallets = new Map((Array.isArray(wallets) ? wallets : [])
    .filter((wallet) => active(wallet) && wallet.capabilities?.includes('trade.paper'))
    .map((wallet) => [wallet.walletId, wallet]));
  return (Array.isArray(pacts) ? pacts : []).filter((pact) => {
    if (!active(pact) || !paperWallets.has(pact.agentWalletId)) return false;
    const deadline = Number(pact.expiresAt || pact.completion?.deadlineTs || 0);
    return !deadline || deadline > now;
  }).map((pact) => ({ wallet: paperWallets.get(pact.agentWalletId), pact }));
}

function earliestExpiry(bindings) {
  const expiries = bindings.map(({ pact }) => Number(pact.expiresAt || pact.completion?.deadlineTs || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return expiries.length ? Math.min(...expiries) : null;
}

function withheld(capability, reasonCode) {
  return { capability, reasonCode };
}

export function buildAgentCapabilityRegistry({
  keys = [], wallets = [], pacts = [], missions = [], runtimesByKey = {}, now = Date.now(),
} = {}) {
  const bindings = activeBindings(wallets, pacts, now);
  const runningMissions = (Array.isArray(missions) ? missions : []).filter((mission) => mission?.status === 'running');
  const rows = (Array.isArray(keys) ? keys : []).map((key) => {
    const revoked = !!key.revokedAt;
    const scopes = revoked ? [] : [...new Set(Array.isArray(key.scopes) ? key.scopes : [])].sort();
    const canRead = scopes.includes('read');
    const canPaper = canRead && scopes.includes('trade-paper');
    const runtime = runtimesByKey?.[key.id] || null;
    const ready = runtimeReady(runtime);
    const authorityAvailable = canPaper && bindings.length > 0;
    const effective = canRead ? [...READ_CAPABILITIES] : [];
    const denied = [];

    if (canPaper && authorityAvailable) effective.push('paper.preflight');
    else denied.push(withheld('paper.preflight', canPaper ? 'owner-approved-delegation-required' : 'trade-paper-scope-required'));

    if (canPaper && authorityAvailable && ready) effective.push('paper.execute');
    else if (!canPaper) denied.push(withheld('paper.execute', 'trade-paper-scope-required'));
    else if (!authorityAvailable) denied.push(withheld('paper.execute', 'owner-approved-delegation-required'));
    else denied.push(withheld('paper.execute', 'supervised-runtime-required'));

    if (canRead && ready && runningMissions.length) effective.push('mission.checkpoint');
    else denied.push(withheld('mission.checkpoint', !canRead ? 'read-scope-required' : !ready ? 'supervised-runtime-required' : 'running-mission-required'));

    effective.sort();
    return {
      agentRef: key.id,
      name: key.name || 'Agent',
      status: revoked ? 'revoked' : effective.includes('paper.execute') ? 'execution-ready' : canRead ? 'observe-only' : 'blocked',
      credentialScopes: scopes,
      effectiveCapabilities: revoked ? [] : effective,
      withheldCapabilities: revoked ? [...PAPER_CAPABILITIES, 'mission.checkpoint'].map((capability) => withheld(capability, 'credential-revoked')) : denied,
      delegation: {
        ownerApprovedCredential: !revoked,
        selfDeclaredAuthorityAccepted: false,
        runtimeReady: ready,
        walletPactAuthorityAvailable: authorityAvailable,
        activeBindingCount: authorityAvailable ? bindings.length : 0,
        completionBound: authorityAvailable && bindings.every(({ pact }) => ['time', 'budget', 'goal'].includes(pact.completion?.type)),
        expiresAt: authorityAvailable ? earliestExpiry(bindings) : null,
        runningMissionCount: runningMissions.length,
      },
    };
  });

  const activeRows = rows.filter((row) => row.status !== 'revoked');
  const executionReady = activeRows.filter((row) => row.status === 'execution-ready').length;
  const scopedButBlocked = activeRows.filter((row) => row.credentialScopes.includes('trade-paper') && row.status !== 'execution-ready').length;
  return {
    ok: true,
    mode: 'paper-only',
    version: 1,
    status: scopedButBlocked ? 'attention' : 'healthy',
    decision: scopedButBlocked ? 'deny' : 'allow',
    reasonCode: scopedButBlocked ? 'delegated-execution-not-ready' : 'capability-registry-clear',
    counts: {
      total: rows.length,
      active: activeRows.length,
      revoked: rows.length - activeRows.length,
      executionReady,
      observeOnly: activeRows.filter((row) => row.status === 'observe-only').length,
      blocked: activeRows.filter((row) => row.status === 'blocked').length,
      activeWalletPactBindings: bindings.length,
      runningMissions: runningMissions.length,
    },
    agents: rows,
    policy: {
      authorityModel: 'intersection-of-independent-server-evidence',
      capabilityVocabulary: [...READ_CAPABILITIES, ...PAPER_CAPABILITIES, 'mission.checkpoint'].sort(),
      scopeMinimization: true,
      ownerApprovalRequired: true,
      runtimeAttestationRequiredForExecution: true,
      walletPactBindingRequiredForExecution: true,
      automaticDelegation: false,
      automaticAgentSubstitution: false,
      revocationFailClosed: true,
    },
    guarantees: {
      selfAssertedAuthorityAccepted: false,
      ownerIsolation: true,
      effectiveAuthorityRecomputed: true,
      executionPermissionsChanged: false,
      authorityExpanded: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

function sanitizedAgent(agent) {
  if (!agent) return {
    status: 'not-registered', credentialScopes: [], effectiveCapabilities: [],
    withheldCapabilities: [], delegation: { ownerApprovedCredential: false, selfDeclaredAuthorityAccepted: false },
  };
  const { agentRef: _agentRef, name: _name, ...safe } = agent;
  return safe;
}

export function registryEvidenceForPrincipal(registry, keyId) {
  const { agents: _agents, ...summary } = registry;
  return { ...summary, currentAgent: sanitizedAgent(registry.agents.find((agent) => agent.agentRef === keyId)) };
}
