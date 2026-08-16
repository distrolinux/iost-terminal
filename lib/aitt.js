// lib/aitt.js — AITT token metadata + points→AITT conversion gate (Phase 1)
//
// Honest framing (TOKENOMICS.md §10): NO token has been created, minted or
// sold. AITT is a design draft; points→AITT 1:1 conversion is PLANNED at TGE
// and explicitly "not guaranteed". The conversion gate stays closed until:
//   (a) the ERC-20 is deployed on IOST L2 + converter funded, and
//   (b) TGE gates pass (10k users · 500 staked agents · ≥40% of circulating staked).
//
// Config: data/aitt-config.json  (runtime — deploy fills addresses/status)
// Claims: data/points-claims.json  (off-chain mirror of on-chain converter
//         claims; written ONLY while the gate is open)

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBalance } from './points.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'aitt-config.json');
const CLAIMS_FILE = join(DATA_DIR, 'points-claims.json');

const DEFAULTS = {
  status: 'design', // design | deployed
  token: {
    name: 'Agent Intelligence Trading Token',
    symbol: 'AITT',
    totalSupply: '1,000,000,000 (1B)',
    decimals: 8,
    chain: 'IOST L2 (EVM, chain 182)',
    rpc: 'https://l2-mainnet.iost.io',
    explorer: 'https://l2-scan.iost.io',
  },
  contractAddress: '', // AITT ERC-20 on IOST L2 (filled at deploy)
  converterAddress: '', // PointsConverter (filled at deploy)
  conversionOpen: false, // TGE gate — the ONLY switch that opens claims
  reserveAITT: 0, // AITT funded into the converter for conversions
  pointsTotal: 0, // live points-ledger snapshot total (reserve sizing input)
  whitepaper: '/whitepaper',
  page: '/aitt',
};

export function getConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      return { ...DEFAULTS, ...raw, token: { ...DEFAULTS.token, ...(raw.token || {}) } };
    }
  } catch { /* corrupt → defaults */ }
  return structuredClone(DEFAULTS);
}

/** Public token info — safe to serve unauthenticated (no secrets, honest status). */
export function getInfo() {
  const cfg = getConfig();
  const totalClaimed = claimedPointsTotal();
  return {
    ok: true,
    status: cfg.status,
    token: cfg.token,
    contractAddress: cfg.contractAddress,
    converterAddress: cfg.converterAddress,
    explorerUrl: cfg.token.explorer,
    conversion: {
      rate: '1:1',
      open: cfg.conversionOpen,
      reserveAITT: cfg.reserveAITT,
      pointsTotal: cfg.pointsTotal,
      claimedAITT: totalClaimed,
      statusText: cfg.conversionOpen
        ? 'open — convert your points to AITT'
        : 'closed — opens at TGE (planned, not guaranteed; nothing issued yet)',
    },
    honesty: 'AITT is a design draft. No token has been created, minted, or sold. Conversion is an earn-event, not a purchase — planned, not guaranteed.',
    links: { whitepaper: cfg.whitepaper, page: cfg.page, explorer: cfg.token.explorer },
  };
}

// ---------------------------------------------------------------------------
// off-chain claim mirror (active ONLY while conversionOpen)
// ---------------------------------------------------------------------------
function loadClaims() {
  try {
    if (existsSync(CLAIMS_FILE)) {
      const parsed = JSON.parse(readFileSync(CLAIMS_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.claims)) return parsed;
    }
  } catch { /* corrupt → fresh */ }
  return { claims: [] };
}

function saveClaims(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CLAIMS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, CLAIMS_FILE);
}

export function claimedPoints(ownerId) {
  return loadClaims().claims
    .filter((c) => c.ownerId === ownerId)
    .reduce((a, c) => a + (c.points || 0), 0);
}

export function claimedPointsTotal() {
  return loadClaims().claims.reduce((a, c) => a + (c.aitt || 0), 0);
}

/**
 * Claim points → AITT (1:1) for the current principal.
 * Gate-first: while conversionOpen is false this NEVER writes — it answers
 * honestly with the gate status. When open: computes claimable =
 * balance − already claimed, records the claim off-chain (the on-chain
 * converter executes the real transfer; this ledger is the mirror).
 */
export function claim({ ownerId }) {
  const cfg = getConfig();
  if (!cfg.conversionOpen) {
    return {
      ok: false,
      error: 'conversion-not-open',
      message: 'AITT conversion opens at TGE. Planned, not guaranteed — nothing has been issued.',
      conversion: getInfo().conversion,
    };
  }
  if (!ownerId) return { ok: false, error: 'ownerId required' };
  const balance = getBalance(ownerId);
  const claimable = Math.max(0, balance - claimedPoints(ownerId));
  if (claimable <= 0) {
    return { ok: false, error: 'nothing-to-claim', message: 'You have no unclaimed points to convert.' };
  }
  if (cfg.reserveAITT - claimedPointsTotal() < claimable) {
    return { ok: false, error: 'reserve-exhausted', message: 'The conversion reserve is exhausted — try again later.' };
  }
  const store = loadClaims();
  store.claims.push({ ownerId, ts: Date.now(), points: claimable, aitt: claimable, status: 'recorded' });
  saveClaims(store);
  return {
    ok: true,
    ownerId,
    pointsConverted: claimable,
    aittIssued: claimable, // 1:1, 8-decimal base units
    remainingPoints: balance - claimable,
    message: `Converted ${claimable} points → ${claimable} AITT (1:1). The on-chain converter executes on IOST L2.`,
  };
}
