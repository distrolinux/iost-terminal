// lib/management.js — v1.13 position management engine
//
// CryptoHopper-inspired, made AI-aware and transparent:
//   1. TRAILING STOPS / TRAILING TAKE-PROFIT — exits that ratchet with price.
//      Long:  peak = highest price since open; stop = peak*(1-pct);
//             trailing TP triggers only when its line is ABOVE entry (profit lock).
//      Short: mirror (peak = lowest price; stop = peak*(1+pct); TP below entry).
//   2. DCA (dollar-cost averaging) — auto-adds to a losing position to lower the
//      average entry, capped (maxTrades, sizeFactor, cooldown), only when the
//      position is down by >= triggerPct.
//
// Design rules:
//   - Every exit is a normal closeTrade() with an honest exitReason — the
//     journal records WHY (trailing stop / trailing TP / DCA trigger metadata).
//   - DCA is optional on a score floor when a score provider is injected
//     (AI-aware: don't average down into a dying setup).
//   - The sweep is idempotent and safe to run every 10s; prices come from an
//     injected fn (defaults to the real getTicker) so tests are deterministic.

import { getExecutionTicker } from './market.js';
import { listAccounts, getState, closeTrade, addToPosition, persistAccounts } from './paper.js';
import { recordMissionClose } from './missions.js';
import { marketEvidence, recordExecutionReceipt } from './execution-receipts.js';
import {
  POSITION_GUARDIAN_CADENCE_MS, completePositionGuardian, ensurePositionGuardian,
  evaluatePositionGuardian, guardianCoverage, publicGuardianPosition,
} from './position-guardian.js';

export const DEFAULT_DCA_MIN_SCORE = 55; // don't DCA into setups scoring below this

let lastSweep = null;

function trailLevels(pos) {
  const long = pos.side === 'long';
  const peak = pos.trailPeak ?? pos.entry;
  const out = { peak };
  if (pos.trailStopPct) {
    out.stop = long ? peak * (1 - pos.trailStopPct) : peak * (1 + pos.trailStopPct);
  }
  if (pos.trailTpPct) {
    const line = long ? peak * (1 - pos.trailTpPct) : peak * (1 + pos.trailTpPct);
    out.tp = line; // effective only when past entry
    out.tpActive = long ? line > pos.entry : line < pos.entry;
  }
  return out;
}

function checkTrailing(pos, price) {
  const long = pos.side === 'long';
  // ratchet the peak in the favorable direction
  pos.trailPeak = long ? Math.max(pos.trailPeak ?? pos.entry, price) : Math.min(pos.trailPeak ?? pos.entry, price);
  const lv = trailLevels(pos);
  if (pos.trailStopPct && (long ? price <= lv.stop : price >= lv.stop)) {
    return { exit: true, reason: `trailing stop (${(pos.trailStopPct * 100).toFixed(1)}% from peak ${fmt(lv.peak)})` };
  }
  if (pos.trailTpPct && lv.tpActive && (long ? price <= lv.tp : price >= lv.tp)) {
    return { exit: true, reason: `trailing take-profit (${(pos.trailTpPct * 100).toFixed(1)}% from peak ${fmt(lv.peak)})` };
  }
  return { exit: false };
}

// Fixed stop/target instructions are part of the original paper order. They
// use the same observed price as trailing management and are journaled with a
// precise reason, so a later export can reproduce why the paper position left.
function checkStaticExit(pos, price) {
  const long = pos.side === 'long';
  if (pos.stop != null && (long ? price <= pos.stop : price >= pos.stop)) {
    return { exit: true, reason: `stop-loss (${fmt(pos.stop)})` };
  }
  if (pos.target != null && (long ? price >= pos.target : price <= pos.target)) {
    return { exit: true, reason: `take-profit (${fmt(pos.target)})` };
  }
  return { exit: false };
}

function checkDca(pos, price, score) {
  if (!pos.dca || !pos.dca.enabled) return { add: false };
  if (pos.dcaCount >= pos.dca.maxTrades) return { add: false };
  if (pos.dcaLastAt && Date.now() - pos.dcaLastAt < pos.dca.cooldownMin * 60_000) return { add: false };
  const pnlPct = pos.entry ? ((price - pos.entry) / pos.entry) * 100 * (pos.side === 'long' ? 1 : -1) : 0;
  if (pnlPct > -pos.dca.triggerPct * 100) return { add: false }; // not down enough
  if (score != null && score < DEFAULT_DCA_MIN_SCORE) return { add: false, reason: `score ${score} < ${DEFAULT_DCA_MIN_SCORE} — no DCA` };
  const extra = Math.round(pos.size * pos.dca.sizeFactor * 10000) / 10000;
  return { add: true, extra, pnlPct };
}

const fmt = (n) => Math.round(n * 100000) / 100000;

/**
 * Run the position-management sweep over ALL paper accounts.
 * @param {object} opts
 * @param {(symbol:string)=>Promise<number>} [opts.priceFn] — injectable price source
 * @param {(symbol:string)=>(number|null)} [opts.scoreFn] — injectable AI score source
 */
export async function sweepManagement({ quoteFn = null, priceFn = null, scoreFn = null, nowFn = Date.now, receiptFn = recordExecutionReceipt } = {}) {
  // priceFn remains as a deterministic-test/backward-compatible alias. The
  // production path uses the stricter execution quote with exit-side routing.
  const quote = quoteFn || priceFn || (async (sym, pos) => getExecutionTicker(sym, pos?.side === 'short' ? 'long' : 'short'));
  const score = scoreFn || (() => null);
  const startedAt = Math.trunc(nowFn());
  const result = {
    ts: startedAt, startedAt, completedAt: null, durationMs: null,
    status: 'healthy', cadenceMs: POSITION_GUARDIAN_CADENCE_MS,
    accounts: 0, checked: 0, trailingExits: [], dcaAdds: [], errors: [],
    guardian: { protected: 0, unprotected: 0, armed: 0, degraded: 0, staleQuotes: 0, quorumFailures: 0, triggered: [], receiptErrors: 0 },
  };
  for (const acc of listAccounts()) {
    const state = getState(acc.accountId);
    if (!state.positions.length) continue;
    result.accounts += 1;
    for (const pos of state.positions.slice()) {
      result.checked += 1;
      const guardian = ensurePositionGuardian(pos, startedAt);
      if (guardian.status === 'unprotected') result.guardian.unprotected += 1;
      else result.guardian.protected += 1;

      let quoteNow;
      try { quoteNow = await quote(pos.symbol, pos); }
      catch (error) {
        quoteNow = null;
        result.errors.push(`${pos.symbol}: guardian quote ${error.message}`);
      }
      const checkedAt = Math.trunc(nowFn());
      const guarded = evaluatePositionGuardian(pos, quoteNow, checkedAt);
      const priceNow = guarded.quote?.price;
      if (priceNow > 0) pos.lastPrice = priceNow;

      if (guarded.reasonCode === 'quote-stale' || guarded.reasonCode === 'quote-unavailable') result.guardian.staleQuotes += 1;
      if (guarded.reasonCode === 'quote-quorum-failed') result.guardian.quorumFailures += 1;
      if (guardian.status === 'degraded') result.guardian.degraded += 1;
      else if (guardian.status !== 'unprotected') result.guardian.armed += 1;

      if (guarded.action === 'close') {
        const beforeState = 'armed';
        const reason = `guardian ${guarded.triggerLeg} (${fmt(guarded.triggerPrice)})`;
        const authority = `guardian-${guarded.quote.source}-${guarded.quote.exitSide}`;
        const closed = await closeTrade(pos.id, guarded.fillPrice, acc.accountId, reason, authority);
        if (!closed.ok) {
          guardian.status = 'degraded'; guardian.lastDecision = 'protective-close-failed';
          guardian.consecutiveFailures += 1;
          result.errors.push(`${pos.symbol}: guardian close ${closed.error}`);
          continue;
        }
        completePositionGuardian(guardian, checkedAt);
        const journal = getState(acc.accountId).journal.find((entry) => entry.id === pos.id);
        if (journal) journal.guardian = structuredClone(guardian);
        persistAccounts();
        try { recordMissionClose(pos.id, acc.owner || acc.accountId, Math.round(Number(closed.pnl || 0) * 100)); } catch { /* no matching mission */ }
        let receipt = null;
        try {
          receipt = receiptFn({
            accountId: acc.accountId, now: checkedAt, action: 'close', outcome: 'accepted',
            request: {
              symbol: pos.symbol, side: pos.side, size: pos.size, requestedEntry: pos.entry,
              requestedNotionalUsd: pos.notional, reasoningSummary: reason, positionId: pos.id,
              intentProtected: false, preflightProtected: false,
            },
            market: marketEvidence({
              ticker: { ...(guarded.quote.raw || {}), last: guarded.fillPrice, observedAt: guarded.quote.observedAt,
                ageMs: guarded.quote.ageMs, fresh: guarded.quote.fresh },
              requestedEntry: pos.entry, side: pos.side, size: pos.size, now: checkedAt,
            }),
            execution: {
              status: 'filled', fillPrice: closed.exitPrice, fillAuthority: authority,
              fillVenue: guarded.quote.routeVenue || guarded.quote.source, feeUsd: 0,
              pnlUsd: closed.pnl, result: closed.result,
            },
            authorization: {
              principal: 'system-guardian', tradePaperScope: true,
              walletPactRequired: false, walletPactAuthorized: true,
              missionRequired: false, missionAuthorized: true,
              preflightRequired: false, preflightAuthorized: true,
              liveScopeUsed: false, publicChainUsed: false,
            },
            policy: {
              decision: 'allow', reasonCode: `guardian-${guarded.triggerLeg}-triggered`,
              detail: 'Server-enforced paper bracket closed risk and cancelled the sibling OCO leg.',
            },
            guardian: {
              version: guardian.version, orderClass: guardian.orderClass,
              triggerLeg: guarded.triggerLeg, cancelledLeg: guarded.cancelledLeg,
              triggerPrice: guarded.triggerPrice, observedExitPrice: guarded.fillPrice,
              protectionStateBefore: beforeState, protectionStateAfter: guardian.status,
              quoteFresh: guarded.quote.fresh, quoteAgeMs: guarded.quote.ageMs,
              quoteQuorumRequired: guarded.quote.quorumRequired,
              quoteQuorumMet: guarded.quote.quorumMet,
              watchdogCadenceMs: POSITION_GUARDIAN_CADENCE_MS,
            },
            latency: { totalMs: Math.max(0, Math.trunc(nowFn()) - checkedAt), authorizationMs: 0, brokerMs: 0, settlementMs: 0 },
          });
          if (journal) { journal.guardianReceiptHash = receipt.hash; persistAccounts(); }
        } catch (error) {
          result.guardian.receiptErrors += 1;
          result.errors.push(`${pos.symbol}: guardian receipt ${error.message}`);
        }
        const event = {
          symbol: pos.symbol, side: pos.side, triggerLeg: guarded.triggerLeg,
          cancelledLeg: guarded.cancelledLeg, triggerPrice: guarded.triggerPrice,
          fillPrice: closed.exitPrice, receiptRecorded: !!receipt,
        };
        result.guardian.triggered.push(event);
        result.trailingExits.push({ symbol: pos.symbol, side: pos.side, reason });
        continue;
      }

      // A protected position with invalid market evidence remains armed but no
      // trailing or DCA action is allowed from that same invalid observation.
      if (!(priceNow > 0) || guarded.quote?.fresh !== true || guarded.quote?.quorumMet !== true || guardian.status === 'degraded') continue;

      const tr = checkTrailing(pos, priceNow);
      if (tr.exit) {
        const closed = await closeTrade(pos.id, priceNow, acc.accountId, tr.reason, 'management-observed-price');
        if (closed.ok) recordMissionClose(pos.id, acc.owner || acc.accountId, Math.round(Number(closed.pnl || 0) * 100));
        result.trailingExits.push({ symbol: pos.symbol, side: pos.side, reason: tr.reason });
        continue; // position closed — no DCA on a closed position
      }

      const d = checkDca(pos, priceNow, score(pos.symbol));
      if (d.add) {
        const r = await addToPosition(pos.id, d.extra, `DCA #${pos.dcaCount + 1} — avg down (${(d.pnlPct).toFixed(1)}% move)`, acc.accountId);
        if (r.ok) {
          pos.dcaCount += 1;
          pos.dcaLastAt = Date.now();
          pos.dcaTrades.push({ at: Date.now(), price: r.fill, size: d.extra, cost: r.cost });
          result.dcaAdds.push({ symbol: pos.symbol, count: pos.dcaCount, size: d.extra, at: r.fill });
        } else {
          result.errors.push(`${pos.symbol}: DCA ${r.error}`);
        }
      }
    }
  }
  persistAccounts();
  result.completedAt = Math.trunc(nowFn());
  result.durationMs = Math.max(0, result.completedAt - result.startedAt);
  if (!result.checked) result.status = 'idle';
  else if (result.errors.length || result.guardian.degraded || result.guardian.receiptErrors) result.status = 'degraded';
  lastSweep = result;
  return result;
}

export function sweepStatus() {
  return lastSweep || {
    ts: null, startedAt: null, completedAt: null, durationMs: null, status: 'starting',
    cadenceMs: POSITION_GUARDIAN_CADENCE_MS, accounts: 0, checked: 0,
    guardian: { protected: 0, unprotected: 0, armed: 0, degraded: 0, staleQuotes: 0, quorumFailures: 0, triggered: [], receiptErrors: 0 },
    trailingExits: [], dcaAdds: [], errors: [],
  };
}

export function positionGuardianStatus(accountId) {
  const state = getState(accountId);
  const coverage = guardianCoverage(state.positions);
  const sweep = sweepStatus();
  return {
    ok: true, mode: 'paper-only', version: 1,
    watchdog: {
      status: sweep.status, cadenceMs: POSITION_GUARDIAN_CADENCE_MS,
      lastStartedAt: sweep.startedAt, lastHeartbeatAt: sweep.completedAt,
      durationMs: sweep.durationMs, checked: sweep.checked,
      staleQuotes: sweep.guardian?.staleQuotes || 0,
      quorumFailures: sweep.guardian?.quorumFailures || 0,
      receiptErrors: sweep.guardian?.receiptErrors || 0,
    },
    coverage,
    positions: state.positions.map(publicGuardianPosition),
    guarantees: {
      serverEnforced: true, survivesAgentDisconnect: true, restartRecovered: true,
      ocoSiblingCancellation: true, freshQuoteRequired: true,
      cryptoQuoteQuorumRequired: true, automaticExitReceipts: true,
    },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

// Update management config on an OPEN position (validated, clamped).
// Returns the updated position or { ok:false }.
export function updatePositionManagement(accountId, positionId, patch) {
  const state = getState(accountId);
  const pos = state.positions.find(p => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };
  if (patch.trailStopPct !== undefined) pos.trailStopPct = patch.trailStopPct != null && +patch.trailStopPct > 0 ? Math.min(+patch.trailStopPct, 0.5) : null;
  if (patch.trailTpPct !== undefined) pos.trailTpPct = patch.trailTpPct != null && +patch.trailTpPct > 0 ? Math.min(+patch.trailTpPct, 0.5) : null;
  if (patch.resetPeak) pos.trailPeak = pos.lastPrice || pos.entry;
  if (patch.dca !== undefined) {
    const d = patch.dca;
    pos.dca = d && d.enabled
      ? {
          enabled: true,
          triggerPct: Math.min(Math.max(+d.triggerPct || 0.05, 0.01), 0.5),
          maxTrades: Math.min(Math.max(+d.maxTrades || 3, 1), 10),
          sizeFactor: Math.min(Math.max(+d.sizeFactor || 0.5, 0.1), 2),
          cooldownMin: Math.max(+d.cooldownMin || 60, 5),
        }
      : null;
  }
  persistAccounts();
  return { ok: true, position: { ...pos, trail: trailLevels(pos) } };
}

export { trailLevels, checkStaticExit, checkTrailing, checkDca };
