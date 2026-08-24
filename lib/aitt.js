// lib/aitt.js — AITT token metadata + machine-enforced release gates.
// AITT remains pre-launch; claims are owned by lib/aitt-claims.js.
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReleaseGates, evaluateLiveReleaseGates, evaluateTradingAccess } from './aitt-release-gates.js';
import { listClaims } from './aitt-claims.js';
import { probeReleaseState, probeTradingState } from './aitt-chain.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'aitt-config.json');
const DEPLOYMENT_JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'deployment-journal.json');

const DEFAULTS = {
  status: 'design',
  token: {
    name: 'Agent Intelligence Trading Token', symbol: 'AITT',
    totalSupply: '1,000,000,000 (1B)', decimals: 8,
    chain: 'IOST L2 (EVM, chain 182)', rpc: 'https://l2-mainnet.iost.io',
    explorer: 'https://l2-scan.iost.io',
  },
  contractAddress: '', converterAddress: '', feeRouterAddress: '', vaultAddresses: {}, deploymentManifestHash: '', releaseApprovalHash: '', governanceOwner: '', deployerAddress: '',
  conversionOpen: false,
  reserveAITT: 0, pointsTotal: 0,
  chainVerification: { verified: false, chainId: 182 },
  reserveVerification: { verified: false },
  releaseGates: { auditApproved: false, counselApproved: false, ownerApproved: false },
  phase4Enabled: false,
  trading: { enabled: false, dex: 'PancakeSwap', chain: 'BNB Smart Chain', chainId: 56, tokenAddress: '', pairAddress: '', factoryAddress: '', quoteToken: '', swapUrl: '' },
  whitepaper: '/whitepaper', page: '/aitt',
};

export function getConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      return {
        ...DEFAULTS,
        ...raw,
        token: { ...DEFAULTS.token, ...(raw.token || {}) },
        trading: { ...DEFAULTS.trading, ...(raw.trading || {}) },
        releaseGates: { ...DEFAULTS.releaseGates, ...(raw.releaseGates || {}) },
      };
    }
  } catch { /* corrupt config fails closed to defaults */ }
  return structuredClone(DEFAULTS);
}

export function getInfo() {
  const cfg = getConfig();
  const gate = evaluateReleaseGates(cfg);
  const trading = evaluateTradingAccess(cfg);
  const totalClaimed = listClaims()
    .filter((claim) => claim.status === 'claimed_onchain')
    .reduce((sum, claim) => sum + claim.points, 0);
  return {
    ok: true,
    status: cfg.status,
    token: cfg.token,
    contractAddress: cfg.contractAddress,
    converterAddress: cfg.converterAddress,
    explorerUrl: cfg.token.explorer,
    conversion: {
      rate: '1:1', open: gate.ready,
      reserveAITT: cfg.reserveAITT, pointsTotal: cfg.pointsTotal, claimedAITT: totalClaimed,
      statusText: gate.ready
        ? 'open — convert your points to AITT'
        : 'closed — pre-launch review hold (planned, not guaranteed; nothing issued yet)',
      releaseGate: gate,
    },
    trading,
    honesty: 'AITT is a design draft. No token has been created, minted, or sold. Conversion is an earn-event, not a purchase — planned, not guaranteed.',
    links: { whitepaper: cfg.whitepaper, page: cfg.page, explorer: cfg.token.explorer },
  };
}

export function verifyDeploymentJournalBinding(config, journal) {
  if (!journal || journal.status !== 'completed' || !journal.deploymentManifest) return false;
  const recomputed = `0x${crypto.createHash('sha256').update(JSON.stringify(journal.deploymentManifest)).digest('hex')}`;
  if (recomputed !== journal.deploymentManifestHash || recomputed !== config.deploymentManifestHash) return false;
  const manifest = journal.deploymentManifest;
  const contracts = manifest.contracts || {};
  const expected = {
    token: config.contractAddress, feeRouter: config.feeRouterAddress, pointsConverter: config.converterAddress,
    ecosystemEmission: config.vaultAddresses?.ecosystemEmission, treasuryVault: config.vaultAddresses?.treasury,
    partnersVault: config.vaultAddresses?.partners, communityVault: config.vaultAddresses?.community,
    reserveVault: config.vaultAddresses?.reserve, teamVesting: config.vaultAddresses?.team, advisorVesting: config.vaultAddresses?.advisor,
  };
  return Number(manifest.chainId) === 182
    && Object.entries(expected).every(([key, value]) => String(contracts[key]).toLowerCase() === String(value).toLowerCase())
    && String(manifest.governanceOwner).toLowerCase() === String(config.governanceOwner).toLowerCase()
    && String(manifest.deployerAddress).toLowerCase() === String(config.deployerAddress).toLowerCase()
    && String(manifest.releaseApprovalHash).toLowerCase() === String(config.releaseApprovalHash).toLowerCase()
    && BigInt(manifest.pointsConversionReserve || 0) === BigInt(config.reserveAITT || 0) * 10n ** 8n;
}

export async function getLiveInfo() {
  const info = getInfo();
  const cfg = getConfig();
  const reservedBaseUnits = listClaims()
    .filter((claim) => claim.status === 'reserved')
    .reduce((sum, claim) => sum + BigInt(claim.baseUnits), 0n);
  const journalProbe = async (config, liabilities) => {
    if (!existsSync(DEPLOYMENT_JOURNAL)) return { verified: false, error: 'completed deployment journal missing' };
    const journal = JSON.parse(readFileSync(DEPLOYMENT_JOURNAL, 'utf8'));
    if (!verifyDeploymentJournalBinding(config, journal)) {
      return { verified: false, error: 'deployment manifest hash/address binding mismatch' };
    }
    return probeReleaseState(config, liabilities);
  };
  const gate = await evaluateLiveReleaseGates(cfg, { probe: journalProbe, reservedBaseUnits });
  const tradingLive = cfg.trading?.enabled === true ? await probeTradingState(cfg.trading) : { verified: false, error: 'trading disabled' };
  const trading = evaluateTradingAccess(cfg, { liveVerified: tradingLive.verified === true });
  return {
    ...info,
    trading: { ...trading, live: tradingLive },
    conversion: {
      ...info.conversion,
      open: gate.ready,
      releaseGate: gate,
      statusText: gate.ready ? 'open — convert your points to AITT' : info.conversion.statusText,
    },
  };
}
