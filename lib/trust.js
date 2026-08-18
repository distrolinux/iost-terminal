// lib/trust.js — Phase 2 Trust Score (DERIVED, never stored)
//
// Per PHASE2_SPEC §3: score is recomputed from inputs on every read —
// there is no stored mutable score to game.
//
//   score = clamp(0..100,
//     base(25)
//     + stakeTier(amount)          // 1k=10 · 10k=25 · 100k=40 (AITT)
//     × lockMultiplier (capped)    // 7d=1.0 · 30d=1.25 · 90d=1.5 · 365d=2.0
//     + complianceHistory          // +5 per 30 clean days, max +15
//     − slashingPenalties)         // unauthorized-spend: reset to 10 · failed-settlement: −25
//
// Credit line (illustrative, calibrate on live data): score/100 × stakeUSD × 10.
// stakeUSD uses a configurable AITT price (0 → line 0, honest).

import { weightedStakeMinor, activeStakeTotalMinor, activeStakes } from './stakes.js';
import { openSlashes } from './slashes.js';

export const TRUST_CONFIG = {
  base: 25,
  stakeTiers: [ // [minMinor, points] — minor = AITT × 10^8
    [1000n * 10n ** 8n, 10n], // 1k AITT
    [10_000n * 10n ** 8n, 25n], // 10k
    [100_000n * 10n ** 8n, 40n], // 100k
  ],
  complianceStepDays: 30,
  complianceMax: 15,
  resetScore: 10,
  failedSettlementPenalty: 25,
  creditMultiplier: 10, // score/100 × stakeUSD × 10
};

export function aittPriceUSD() {
  // Phase 2: no market price yet — configurable, 0 = no credit line (honest).
  const p = Number(process.env.AITT_PRICE_USD || '0');
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export function stakeTierPoints(minor) {
  const amt = BigInt(minor || 0);
  let pts = 0n;
  for (const [min, p] of TRUST_CONFIG.stakeTiers) {
    if (amt >= min) pts = p;
  }
  return pts;
}

/** Compliance history: +5 per 30 clean days of stake tenure, max +15. */
export function compliancePoints(ownerId, activeStakes) {
  const clean = activeStakes.length ? Math.floor((Date.now() - Math.min(...activeStakes.map((s) => s.startTs))) / (30 * 24 * 3600 * 1000)) : 0;
  return Math.min(TRUST_CONFIG.complianceMax, clean * 5);
}

/**
 * Compute the Trust Score + credit line for an owner. Pure function — no writes.
 * Returns components so the UI can show WHY.
 */
export function computeTrust(ownerId, { stakes, slashes } = {}) {
  const st = stakes || activeStakeTotalMinor(ownerId);
  const rows = activeStakes(ownerId);
  const compliance = compliancePoints(ownerId, rows);

  const weighted = weightedStakeMinor(ownerId);
  const totalMinor = st;
  const tier = stakeTierPoints(totalMinor);

  // lock multiplier on the weighted amount vs raw: effective bonus capped at 2×
  const raw = totalMinor > 0n ? totalMinor : 1n;
  const lockFactor = weighted > 0n ? Number(weighted) / Number(raw) : 1.0;
  const lockCapped = Math.min(2.0, Math.max(1.0, lockFactor));

  const open = slashes || openSlashes(ownerId);
  const hasUnauthorized = open.some((s) => s.trustReset);
  const failedCount = open.filter((s) => !s.trustReset).length;

  let score;
  if (hasUnauthorized) {
    score = TRUST_CONFIG.resetScore; // score reset — hard rule
  } else {
    score = TRUST_CONFIG.base
      + Number(tier) * lockCapped
      + compliance
      - failedCount * TRUST_CONFIG.failedSettlementPenalty;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  // credit line (USD minor units)
  const price = aittPriceUSD();
  const stakeUSDMinor = price > 0 ? (Number(totalMinor) / 1e8) * price * 100 : 0;
  const creditLineMinor = price > 0 ? Math.trunc((score / 100) * stakeUSDMinor * TRUST_CONFIG.creditMultiplier) : 0;

  return {
    ownerId,
    score,
    creditLineMinor,
    stakeAITT: (totalMinor / 10n ** 8n).toString(),
    components: {
      base: TRUST_CONFIG.base,
      stakeTierPoints: Number(tier),
      lockMultiplier: Number(lockCapped.toFixed(2)),
      compliance,
      penalties: { trustReset: hasUnauthorized, failedSettlements: failedCount, failedSettlementPenalty: TRUST_CONFIG.failedSettlementPenalty },
    },
    config: { priceUSD: price, creditMultiplier: TRUST_CONFIG.creditMultiplier },
    honest: 'Score is derived from current stakes, locks, compliance and open slashes — nothing stored.',
  };
}
