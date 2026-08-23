// lib/autopilot.js — Autonomous strategy engine (machine-first execution)
// Loop: scan → score → risk-size → paper execute → journal. No human in the loop.
// Safety rails: max concurrent positions, daily trade cap, per-trade risk %,
// daily-loss halt, score/RSI-based exits. Everything audited in `actions`.
import { getState, closeTrade, markToMarket } from './paper.js';
import { getBroker } from './broker/index.js';
import { anyLiveEnabled } from './live.js';
import { scanAll, analyzeSymbol } from './scanner.js';
import { computeScores } from './score.js';
import { getAssetSentiment } from './news.js';
import { applyGarchSizing } from './garch.js';

const state = {
  enabled: false,
  running: false,
  startedAt: null,
  config: {
    openMinScore: 60,      // composite >= to consider an entry
    openMaxRisk: 55,       // require risk subscore >= (100 = lowest risk)
    exitScore: 50,         // close when composite drops below
    exitRsi: 78,           // close when RSI exceeds
    minRr: 1.5,            // skip setups below this reward:risk
    stopBuffer: 0.02,      // 2% stop buffer when no support/resistance
    takeProfitR: 2.0,      // target = risk * this multiple
    maxConcurrent: 2,
    maxTradesPerDay: 4,
    accountRiskPct: 0.5,   // per-trade risk % of account
    maxNotionalPct: 50,    // cap position notional at this % of account (exposure guard)
    dailyLossHaltPct: -5,  // halt if day P&L <= this % of account
    side: 'long',
    assetType: 'crypto',
    requireApproval: false, // ARD: when true, entries queue as proposals for human/agent approval instead of executing
  },
  actions: [],             // audit trail, newest first
  proposals: [],           // human-in-the-loop queue (requireApproval mode)
  proposalSeq: 1,
  dayKey: null,
  dayTrades: 0,
  dayStartEquity: null,
  lastTick: null,
  ticks: 0,
};

function log(type, symbol, detail, score = null) {
  state.actions.unshift({ ts: Date.now(), type, symbol, detail, score });
  state.actions = state.actions.slice(0, 120);
}

function dayRollover() {
  const key = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== key) { state.dayKey = key; state.dayTrades = 0; state.dayStartEquity = null; }
}

export function getAutopilot() { return state; }
export function startAutopilot(cfg = null) {
  if (cfg && typeof cfg === 'object') Object.assign(state.config, cfg);
  state.enabled = true;
  state.startedAt = Date.now();
  log('start', null, `autopilot enabled (minScore ${state.config.openMinScore}, max ${state.config.maxConcurrent} concurrent, ${state.config.accountRiskPct}%/trade)`);
}
export function stopAutopilot() {
  state.enabled = false;
  log('stop', null, 'autopilot disabled by operator');
}
export function setAutopilotConfig(cfg) {
  Object.assign(state.config, cfg);
  log('config', null, JSON.stringify(cfg));
  return state.config;
}

// ---- ARD: transparent reasoning + human-in-the-loop overrides ----
// Every entry decision becomes a proposal. With requireApproval=true the tick
// QUEUES it (nothing executes); an operator/agent approves or rejects via API.
// The proposal carries the full reasoning: grade, composite, subscores, stop,
// target, R:R and confidence — visible BEFORE execution.
export function getProposals() { return state.proposals.filter(p => p.status === 'pending'); }

function addProposal(proposal) {
  const id = `P${Date.now().toString(36)}-${state.proposalSeq++}`;
  state.proposals.unshift({ id, ...proposal, status: 'pending', ts: Date.now() });
  state.proposals = state.proposals.slice(0, 50);
  log('proposal', proposal.symbol, `awaiting approval: ${proposal.side} ${Math.round(proposal.size)} @ ${proposal.entry} (${proposal.reason})`, proposal.confidence);
  return state.proposals[0];
}

export async function approveProposal(id) {
  const p = state.proposals.find(x => x.id === id && x.status === 'pending');
  if (!p) return { ok: false, error: 'proposal not found or already decided' };
  const res = await getBroker('paper').placeOrder({
    symbol: p.symbol, side: p.side, size: p.size, stop: p.stop, target: p.target,
    accountSize: p.accountSize, maxRiskPct: p.maxRiskPct,
    reason: `autopilot (human-approved): ${p.reason}`,
    confidence: p.confidence,
  }).catch(() => ({ ok: false, error: 'trade failed' }));
  p.decidedAt = Date.now();
  if (res.ok) {
    p.status = 'approved';
    state.dayTrades++;
    log('entry', p.symbol, `approved proposal → ${p.side} ${Math.round(res.position.size)} @ ${p.entry}`, p.confidence);
  } else {
    p.status = 'failed';
    log('error', p.symbol, `approve failed: ${res.error}`);
  }
  return { ok: res.ok, proposal: p };
}

export function rejectProposal(id) {
  const p = state.proposals.find(x => x.id === id && x.status === 'pending');
  if (!p) return { ok: false, error: 'proposal not found or already decided' };
  p.status = 'rejected'; p.decidedAt = Date.now();
  log('reject', p.symbol, 'proposal rejected by operator', p.confidence);
  return { ok: true, proposal: p };
}

export async function tickAutopilot() {
  if (!state.enabled || state.running) return { ran: false, reason: state.enabled ? 'already running' : 'disabled' };
  state.running = true;
  state.ticks++;
  try {
    dayRollover();
    const paper = await markToMarket();
    const account = paper.account.initialCash || 100000;
    if (state.dayStartEquity == null) state.dayStartEquity = account;

    // --- safety: daily loss halt ---
    const closedToday = paper.journal.filter(j => j.closedAt && new Date(j.closedAt).toISOString().slice(0, 10) === state.dayKey);
    const dayPnl = closedToday.reduce((a, j) => a + (j.pnl || 0), 0);
    const dayPnlPct = (dayPnl / state.dayStartEquity) * 100;
    if (dayPnlPct <= state.config.dailyLossHaltPct) {
      for (const p of paper.positions) { await closeTrade(p.id).catch(() => {}); log('halt-close', p.symbol, 'daily loss limit'); }
      state.enabled = false;
      log('halt', null, `day P&L ${dayPnlPct.toFixed(2)}% hit halt → autopilot stopped`);
      state.lastTick = Date.now();
      return { ran: true, halted: true, dayPnlPct };
    }

    // --- exits: score decay / RSI exhaustion ---
    for (const p of [...paper.positions]) {
      try {
        const a = await analyzeSymbol(p.symbol, { force: false });
        const sc = computeScores(a, getAssetSentiment(p.symbol));
        const rsi = a.indicators?.rsi;
        if (sc.composite < state.config.exitScore || (rsi != null && rsi > state.config.exitRsi)) {
          const why = sc.composite < state.config.exitScore
            ? `score ${sc.composite} < ${state.config.exitScore}` : `RSI ${rsi.toFixed(0)} > ${state.config.exitRsi}`;
          const r = await closeTrade(p.id).catch(() => null);
          log('exit', p.symbol, `${why} → ${r ? `P&L ${r.pnl.toFixed(2)}` : 'close failed'}`, sc.composite);
        }
      } catch { /* skip unreadable symbol */ }
    }

    // --- entries: top-scored candidates, risk-sized, R:R filtered ---
    const openCount = paper.positions.length;
    if (openCount < state.config.maxConcurrent && state.dayTrades < state.config.maxTradesPerDay) {
      const scan = await scanAll();
      const candidates = [];
      for (const a of scan) {
        if (state.config.assetType === 'crypto' && a.type !== 'crypto') continue;
        if (state.config.assetType === 'stock' && a.type !== 'stock') continue;
        const sc = computeScores(a, getAssetSentiment(a.symbol));
        if (sc.composite >= state.config.openMinScore && sc.subscores.risk >= state.config.openMaxRisk) {
          candidates.push({ a, sc });
        }
      }
      candidates.sort((x, y) => y.sc.composite - x.sc.composite);
      const budget = state.config.maxConcurrent - openCount;
      for (const { a, sc } of candidates.slice(0, budget)) {
        if (state.dayTrades >= state.config.maxTradesPerDay) break;
        const entry = a.price;
        const stop = (a.indicators?.support && a.indicators.support < entry)
          ? a.indicators.support
          : entry * (1 - state.config.stopBuffer);
        const riskPerUnit = entry - stop;
        if (riskPerUnit <= 0) continue;
        const target = entry + riskPerUnit * state.config.takeProfitR;
        const rr = (target - entry) / riskPerUnit;
        if (rr < state.config.minRr) continue;
        const dollarRisk = account * (state.config.accountRiskPct / 100);
        const baseSize = dollarRisk / riskPerUnit;
        // GARCH risk throttle (opt-in via GARCH_ENABLED=1): scale exposure by
        // forecast vol — storm → 0.25x–0.5x, calm → up to 2.0x. Fail-soft → 1.0x.
        const gs = await applyGarchSizing(a.symbol, baseSize);
        const size = gs.size;
        const notional = size * entry;
        if (notional > account * (state.config.maxNotionalPct / 100)) {
          log('skip', a.symbol, `notional ${Math.round(notional)} > ${state.config.maxNotionalPct}% cap`, sc.composite);
          continue;
        }
        const proposal = {
          symbol: a.symbol, side: 'long', size, entry, stop, target, rr,
          reason: `${sc.grade} ${sc.composite}/100 (mom ${sc.subscores.momentum} · vol ${sc.subscores.volume} · risk ${sc.subscores.risk})`,
          confidence: sc.composite,
          accountSize: account, maxRiskPct: state.config.accountRiskPct,
          garch: { multiplier: gs.multiplier, regime: gs.regime, stormCapped: gs.stormCapped },
        };
        if (state.config.requireApproval || anyLiveEnabled()) { addProposal(proposal); continue; }
        const res = await getBroker('paper').placeOrder({
          symbol: a.symbol, side: 'long', size, stop, target,
          accountSize: account, maxRiskPct: state.config.accountRiskPct,
          reason: `autopilot: ${sc.grade} ${sc.composite}/100 (mom ${sc.subscores.momentum} vol ${sc.subscores.volume})`,
          confidence: sc.composite,
        }).catch(() => ({ ok: false, error: 'trade failed' }));
        if (res.ok) {
          state.dayTrades++;
          log('entry', a.symbol, `score ${sc.composite} ${sc.grade} · size ${res.position.size} · stop ${stop} · target ${target} · garch ${gs.multiplier}x ${gs.regime}${gs.stormCapped ? ' (capped)' : ''}`, sc.composite);
        }
      }
    }
    state.lastTick = Date.now();
    return { ran: true };
  } catch (e) {
    log('error', null, e.message);
    state.lastTick = Date.now();
    return { ran: true, error: e.message };
  } finally {
    state.running = false;
  }
}
