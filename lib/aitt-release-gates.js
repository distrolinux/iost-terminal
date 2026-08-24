// Machine-verifiable release gates for AITT conversion/TGE.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const isEvidenceHash = (value) => HASH_RE.test(String(value || '')) && !/^0x0{64}$/i.test(String(value));
const isSetAddress = (value) => ADDRESS_RE.test(String(value || '')) && !/^0x0{40}$/i.test(String(value));
const isApprovedSwapUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'pancakeswap.finance' || url.hostname.endsWith('.pancakeswap.finance'));
  } catch { return false; }
};

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
    release_approval_hash: isEvidenceHash(config.releaseApprovalHash),
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

// Phase 4 trading is independent from the canonical Phase 1 conversion gate.
// It fails closed unless every deployment, pair and approved-DEX field is set.
export function evaluateTradingAccess(config = {}) {
  const trading = config.trading || {};
  const checks = {
    trading_requested: trading.enabled === true,
    phase4_enabled: config.phase4Enabled === true,
    status_deployed: config.status === 'deployed',
    token_address: isSetAddress(config.contractAddress),
    bsc_chain: Number(trading.chainId) === 56,
    pair_address: isSetAddress(trading.pairAddress),
    approved_dex: trading.dex === 'PancakeSwap',
    approved_swap_url: isApprovedSwapUrl(trading.swapUrl),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    ready: failed.length === 0,
    checks,
    failed,
    dex: trading.dex || 'PancakeSwap',
    chain: trading.chain || 'BNB Smart Chain',
    chainId: Number(trading.chainId) || 56,
    pairAddress: isSetAddress(trading.pairAddress) ? trading.pairAddress : '',
    swapUrl: failed.length === 0 ? trading.swapUrl : '',
    statusText: failed.length === 0 ? 'live — verified external-liquidity route' : 'disabled — Phase 4 liquidity is not live',
  };
}
