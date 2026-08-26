// Agent Trust Arena — paper-only, hash-chained evidence and derived scoring.
// Scores are never accepted from clients and never stored as mutable state.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const AUDIT_FILE = join(DATA_DIR, 'arena-audit.jsonl');
const ZERO_HASH = '0'.repeat(64);
const STARTING_EQUITY = 100_000;
const MIN_RANKED_TRADES = 5;

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const round = (n, places = 2) => {
  const p = 10 ** places;
  return Math.round((Number(n) + Number.EPSILON) * p) / p;
};
const finite = (n, name) => {
  const out = Number(n);
  if (!Number.isFinite(out)) throw new Error(`${name} must be finite`);
  return out;
};
const positive = (n, name) => {
  const out = finite(n, name);
  if (out <= 0) throw new Error(`${name} must be positive`);
  return out;
};

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');

export function sanitizeReasoning({ reason = '', trail = [] } = {}) {
  const cleanTrail = Array.isArray(trail) ? trail.slice(0, 20).map((row) => {
    if (!row || typeof row !== 'object') return null;
    const confidence = row.confidence == null ? null : Number(row.confidence);
    return {
      step: String(row.step || '').slice(0, 200),
      input: String(row.input || '').slice(0, 300),
      output: String(row.output || '').slice(0, 300),
      confidence: Number.isFinite(confidence) ? round(clamp(confidence, 0, 1), 4) : null,
    };
  }).filter(Boolean) : [];
  return { reason: String(reason || '').slice(0, 500), trail: cleanTrail };
}

function readAudit() {
  if (!existsSync(AUDIT_FILE)) return [];
  return readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { return { malformed: true, line: index + 1 }; }
  });
}

export function verifyAudit(records = readAudit()) {
  let prevHash = ZERO_HASH;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || row.malformed || row.version !== 1 || row.seq !== i + 1 || row.prevHash !== prevHash) {
      return { ok: false, count: i, error: `audit chain invalid at record ${i + 1}` };
    }
    if (row.payloadHash !== sha256(row.payload)) return { ok: false, count: i, error: `payload hash mismatch at record ${i + 1}` };
    const envelope = { version: row.version, seq: row.seq, ts: row.ts, event: row.event, payloadHash: row.payloadHash, prevHash: row.prevHash };
    if (row.hash !== sha256(envelope)) return { ok: false, count: i, error: `record hash mismatch at record ${i + 1}` };
    prevHash = row.hash;
  }
  return { ok: true, count: records.length, headHash: prevHash };
}

function appendAudit(event, payload, now = Date.now()) {
  const records = readAudit();
  const verified = verifyAudit(records);
  if (!verified.ok) throw new Error(verified.error);
  const envelope = {
    version: 1,
    seq: records.length + 1,
    ts: Math.trunc(now),
    event,
    payloadHash: sha256(payload),
    prevHash: verified.headHash,
  };
  const row = { ...envelope, payload, hash: sha256(envelope) };
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(AUDIT_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(AUDIT_FILE, 0o600);
  return row;
}

export function recordOpen({ agentId, name, kind, accountId, trade, priceProvider = 'market', reason, trail, now = Date.now() }) {
  if (!agentId || !accountId || !trade?.id) throw new Error('agent, account and trade identity required');
  const rationale = sanitizeReasoning({ reason, trail });
  return appendAudit('paper-trade-opened', {
    mode: 'paper', fillAuthority: 'server-market', agentId: String(agentId),
    name: String(name || agentId).slice(0, 80), kind: kind === 'human' ? 'human' : 'ai',
    accountId: String(accountId), tradeId: String(trade.id), symbol: String(trade.symbol || '').toUpperCase(),
    side: trade.side === 'short' ? 'short' : 'long', entryPrice: positive(trade.entry, 'entry price'),
    size: positive(trade.size, 'size'), notional: positive(trade.notional, 'notional'),
    openedAt: Math.trunc(finite(trade.openedAt || now, 'openedAt')),
    priceProvider: String(priceProvider || 'market').slice(0, 80), rationale,
  }, now);
}

export function getOpenEvidence({ agentId, accountId, tradeId }) {
  const records = readAudit();
  if (!verifyAudit(records).ok) return null;
  const open = records.find((r) => r.event === 'paper-trade-opened'
    && r.payload.agentId === agentId && r.payload.accountId === accountId && r.payload.tradeId === tradeId);
  if (!open) return null;
  const terminal = records.find((r) => (r.event === 'paper-trade-closed' || r.event === 'paper-trade-voided') && r.payload.openAuditHash === open.hash);
  return terminal ? null : open;
}

export function recordVoid({ openEvidence, reason = 'authorization settlement failed', now = Date.now() }) {
  if (!openEvidence?.hash) throw new Error('open evidence required');
  return appendAudit('paper-trade-voided', {
    mode: 'paper', openAuditHash: openEvidence.hash, agentId: openEvidence.payload.agentId,
    accountId: openEvidence.payload.accountId, tradeId: openEvidence.payload.tradeId,
    reason: String(reason).slice(0, 200),
  }, now);
}

export function recordClose({ openEvidence, journal, exitPrice, priceProvider = 'market', now = Date.now() }) {
  if (!openEvidence?.hash || openEvidence.event !== 'paper-trade-opened') throw new Error('verified open evidence required');
  if (!journal || journal.status !== 'closed' || journal.id !== openEvidence.payload.tradeId) throw new Error('matching closed paper journal required');
  const payload = {
    mode: 'paper', fillAuthority: 'server-market', openAuditHash: openEvidence.hash,
    agentId: openEvidence.payload.agentId, name: openEvidence.payload.name, kind: openEvidence.payload.kind,
    accountId: openEvidence.payload.accountId, tradeId: openEvidence.payload.tradeId,
    symbol: openEvidence.payload.symbol, side: openEvidence.payload.side,
    entryPrice: openEvidence.payload.entryPrice, exitPrice: positive(exitPrice, 'exit price'),
    size: openEvidence.payload.size, notional: openEvidence.payload.notional,
    pnl: finite(journal.pnl, 'pnl'), pnlPct: finite(journal.pnlPct, 'pnlPct'),
    result: ['win', 'loss', 'breakeven'].includes(journal.result) ? journal.result : 'breakeven',
    openedAt: openEvidence.payload.openedAt, closedAt: Math.trunc(finite(journal.closedAt || now, 'closedAt')),
    entryPriceProvider: openEvidence.payload.priceProvider,
    exitPriceProvider: String(priceProvider || 'market').slice(0, 80),
    rationale: openEvidence.payload.rationale,
  };
  return appendAudit('paper-trade-closed', payload, now);
}

function metricsFor(agentId, closes, auditOk) {
  const trades = closes.filter((r) => r.payload.agentId === agentId).sort((a, b) => a.payload.closedAt - b.payload.closedAt);
  let equity = STARTING_EQUITY;
  let peak = equity;
  let maxDrawdownPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const returns = [];
  for (const row of trades) {
    const p = row.payload;
    equity += p.pnl;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 100);
    if (p.pnl > 0) grossProfit += p.pnl;
    if (p.pnl < 0) grossLoss += Math.abs(p.pnl);
    returns.push(p.notional > 0 ? (p.pnl / p.notional) * 100 : 0);
  }
  const count = trades.length;
  const wins = trades.filter((r) => r.payload.result === 'win').length;
  const losses = trades.filter((r) => r.payload.result === 'loss').length;
  const winRate = count ? (wins / count) * 100 : 0;
  const mean = count ? returns.reduce((a, n) => a + n, 0) / count : 0;
  const volatility = count ? Math.sqrt(returns.reduce((a, n) => a + ((n - mean) ** 2), 0) / count) : 0;
  const returnPct = ((equity - STARTING_EQUITY) / STARTING_EQUITY) * 100;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
  const pfForScore = profitFactor == null ? 2 : Math.min(profitFactor, 2);
  const performanceScore = clamp(50
    + clamp(returnPct * 2, -30, 30)
    + clamp((pfForScore - 1) * 10, -10, 10)
    + clamp((winRate - 50) * 0.2, -10, 10));
  const lossRate = count ? (losses / count) * 100 : 0;
  const riskScore = clamp(100 - clamp(maxDrawdownPct * 4, 0, 60) - clamp(volatility * 1.5, 0, 25) - clamp(lossRate * 0.15, 0, 15));
  const explained = trades.filter((r) => r.payload.rationale?.reason || r.payload.rationale?.trail?.length).length;
  const reasoningCoveragePct = count ? (explained / count) * 100 : 0;
  const evidenceScore = clamp(Math.min(60, count * 6) + reasoningCoveragePct * 0.25 + (auditOk ? 15 : 0));
  const trustScore = clamp(performanceScore * 0.45 + riskScore * 0.35 + evidenceScore * 0.2);
  const latest = trades.at(-1)?.payload || {};
  return {
    agentId, name: latest.name || agentId, kind: latest.kind || 'ai',
    status: count >= MIN_RANKED_TRADES ? 'ranked' : 'provisional', verifiedTrades: count,
    wins, losses, winRate: round(winRate, 1), totalPnl: round(equity - STARTING_EQUITY),
    returnPct: round(returnPct), profitFactor: profitFactor == null ? null : round(profitFactor),
    maxDrawdownPct: round(maxDrawdownPct), tradeReturnVolatilityPct: round(volatility),
    reasoningCoveragePct: round(reasoningCoveragePct, 1),
    scores: { trust: round(trustScore, 1), performance: round(performanceScore, 1), risk: round(riskScore, 1), evidence: round(evidenceScore, 1) },
    riskBand: riskScore >= 85 ? 'low' : riskScore >= 70 ? 'moderate' : 'high',
  };
}

export function leaderboard() {
  const records = readAudit();
  const audit = verifyAudit(records);
  if (!audit.ok) return { ok: false, mode: 'paper-only', audit, agents: [] };
  const closes = records.filter((r) => r.event === 'paper-trade-closed' && r.payload.mode === 'paper' && r.payload.fillAuthority === 'server-market');
  const ids = [...new Set(closes.map((r) => r.payload.agentId))];
  const agents = ids.map((id) => metricsFor(id, closes, true)).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ranked' ? -1 : 1;
    return b.scores.trust - a.scores.trust || b.verifiedTrades - a.verifiedTrades;
  }).map((a, index) => ({ ...a, rank: a.status === 'ranked' ? index + 1 : null }));
  return {
    ok: true, mode: 'paper-only', audit, minimumRankedTrades: MIN_RANKED_TRADES,
    startingEquity: STARTING_EQUITY, agents,
    formula: {
      trust: '45% performance + 35% risk + 20% evidence',
      performance: '50 + capped return contribution + profit-factor contribution + win-rate contribution',
      risk: '100 - drawdown penalty - trade-return volatility penalty - loss-rate penalty',
      evidence: 'up to 60 trade-count points + 25 reasoning-coverage points + 15 valid-audit points',
    },
    honesty: 'Only server-priced paper trades opened and closed through Arena routes count. Agent-submitted reasoning is transparent but is not treated as independently verified fact.',
  };
}

export function agentDetail(agentId, limit = 100) {
  const board = leaderboard();
  if (!board.ok) return board;
  const agent = board.agents.find((a) => a.agentId === agentId);
  if (!agent) return null;
  const records = readAudit();
  const events = records.filter((r) => r.payload?.agentId === agentId).slice(-Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { ok: true, mode: 'paper-only', agent, events, audit: board.audit, formula: board.formula, honesty: board.honesty };
}
