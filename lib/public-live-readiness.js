// Deterministic readiness evidence for a future public, non-custodial live
// launch. It is intentionally unable to enable live mode or place an order.

export function buildPublicLiveReadiness({
  security,
  releaseTrust,
  venueConnected = false,
  liveFeatureAvailable = false,
  venuePermissionVerified = false,
  secretVaultReady = false,
  transactionAuthorizationReady = false,
  independentAuditVerified = false,
  complianceApproved = false,
  jurisdictionControlsReady = false,
} = {}) {
  const gates = [
    { code: 'security-sentinel-evidence', label: 'Security Sentinel evidence', pass: security?.status === 'healthy' && security?.evidenceSufficient === true },
    { code: 'release-provenance', label: 'Release and dependency integrity', pass: releaseTrust?.decision === 'allow' },
    { code: 'per-user-venue', label: 'User-controlled venue connection', pass: venueConnected === true },
    { code: 'least-privilege-venue-key', label: 'Trade-only key; withdrawals and transfers absent', pass: venuePermissionVerified === true },
    { code: 'dedicated-secret-vault', label: 'Dedicated production secret vault', pass: secretVaultReady === true },
    { code: 'transaction-authorization', label: 'Unique owner authorization bound to each live order', pass: transactionAuthorizationReady === true },
    { code: 'independent-security-audit', label: 'Independent security and execution audit', pass: independentAuditVerified === true },
    { code: 'jurisdiction-controls', label: 'Jurisdiction, eligibility and sanctions controls', pass: jurisdictionControlsReady === true },
    { code: 'compliance-approval', label: 'Documented legal and compliance approval', pass: complianceApproved === true },
    { code: 'production-live-feature', label: 'Production live feature explicitly enabled', pass: liveFeatureAvailable === true },
  ];
  const failed = gates.filter((gate) => !gate.pass);
  const ready = failed.length === 0;
  return {
    ok: true,
    mode: 'live-readiness-only',
    version: 1,
    status: ready ? 'ready-for-controlled-canary' : 'locked',
    decision: ready ? 'allow-controlled-canary' : 'deny',
    reasonCode: ready ? 'public-live-readiness-passed' : failed[0].code,
    launchModel: {
      custody: 'user-controlled-exchange-or-wallet',
      platformCustody: false,
      automaticWithdrawals: false,
      automaticTransfers: false,
      agentSelfAuthorization: false,
      initialOrderApproval: 'per-order-owner-authorization',
      availability: 'jurisdiction-and-venue-dependent',
    },
    gates,
    progress: { passed: gates.length - failed.length, total: gates.length, percent: Math.round(((gates.length - failed.length) / gates.length) * 100) },
    blockers: failed.map(({ code, label }) => ({ code, label })),
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    executionPermissionsChanged: false,
    authorityExpanded: false,
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

