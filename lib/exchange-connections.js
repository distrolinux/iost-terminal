// Owner-private, read-only connection evidence. Never return provider payloads
// wholesale: persisted status may contain fields unsuitable for the browser.
export function buildExchangeConnections({ kraken = {}, readiness = {} } = {}) {
  const configured = kraken.configured === true;
  const permissionsVerified = configured && kraken.permissionsVerified === true;
  return {
    version: 1,
    mode: 'connection-readiness-only',
    executionAuthority: 'none',
    connections: [{
      provider: 'kraken', name: 'Kraken', transport: 'api-key',
      status: configured ? 'configured-not-live-authorized' : 'not-connected',
      configured, permissionsVerified,
      permissionStatus: permissionsVerified ? 'verified-by-existing-validator' : 'not-verified',
      accountHealth: 'not-probed',
      tradability: 'requires-fresh-provider-check',
    }],
    // Adapter intentions, not connected accounts or promises of availability.
    plannedAdapters: [{ provider: 'robinhood', name: 'Robinhood', transport: 'authenticated-mcp', status: 'not-integrated' }],
    boundaries: {
      paperBalancesUsableLive: false, paperApprovalsUsableLive: false,
      agentSelfAuthorization: false, credentialsAcceptedHere: false,
      withdrawalsSupportedHere: false, transfersSupportedHere: false,
      directProviderAgentCallsCovered: false,
    },
    launchDecision: readiness.decision === 'allow-controlled-canary' ? 'canary-review-required' : 'locked',
    execution: { attempted: false, tradeCreated: false, reservationCreated: false },
    authorityExpanded: false,
  };
}
