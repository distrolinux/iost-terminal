// Machine-verifiable release gates for AITT conversion/TGE.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const isSetAddress = (value) => ADDRESS_RE.test(String(value || '')) && !/^0x0{40}$/i.test(String(value));

export function evaluateReleaseGates(config = {}, { liveVerified = false } = {}) {
  const manifestHash = String(config.deploymentManifestHash || '');
  const checks = {
    conversion_requested: config.conversionOpen === true,
    status_deployed: config.status === 'deployed',
    token_address: isSetAddress(config.contractAddress),
    fee_router_address: isSetAddress(config.feeRouterAddress),
    converter_address: isSetAddress(config.converterAddress),
    ecosystem_vault: isSetAddress(config.vaultAddresses?.ecosystemEmission),
    treasury_vault: isSetAddress(config.vaultAddresses?.treasury),
    partners_vault: isSetAddress(config.vaultAddresses?.partners),
    community_vault: isSetAddress(config.vaultAddresses?.community),
    reserve_vault: isSetAddress(config.vaultAddresses?.reserve),
    team_vesting: isSetAddress(config.vaultAddresses?.team),
    advisor_vesting: isSetAddress(config.vaultAddresses?.advisor),
    deployment_manifest_hash: HASH_RE.test(manifestHash),
    independent_audit_approved: config.releaseGates?.auditApproved === true,
    refreshed_counsel_approved: config.releaseGates?.counselApproved === true,
    explicit_owner_approved: config.releaseGates?.ownerApproved === true,
    phase4_disabled: config.phase4Enabled !== true,
    live_chain_and_reserve_verified: liveVerified === true,
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { ready: failed.length === 0, checks, failed };
}

export async function evaluateLiveReleaseGates(config, { probe, reservedBaseUnits = 0n } = {}) {
  if (typeof probe !== 'function') return evaluateReleaseGates(config);
  let live;
  try { live = await probe(config, BigInt(reservedBaseUnits)); }
  catch (error) { live = { verified: false, error: error.message }; }
  return { ...evaluateReleaseGates(config, { liveVerified: live?.verified === true }), live };
}
