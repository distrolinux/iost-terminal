// Paper execution truth layer. Each account has an independent SHA-256 chain
// inside one append-only JSONL store. Raw account, wallet, Pact, position and
// reservation identifiers are never persisted in a receipt.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionIntentRef } from './execution-intents.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'execution-receipts.jsonl');
const ZERO_HASH = '0'.repeat(64);
const MAX_LIST = 200;

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
const accountRef = (accountId) => sha256(`iost-terminal:paper-receipts:v1:${String(accountId || '')}`);
const opaqueRef = (kind, value) => value ? sha256(`iost-terminal:${kind}:v1:${String(value)}`) : null;
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 4) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};
const clean = (value, max = 200) => String(value || '').trim().slice(0, max);

export function redactReason(value) {
  return clean(value, 500)
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}

function readRows() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { return { malformed: true, line: index + 1 }; }
  });
}

export function verifyReceiptChain(accountId, rows = readRows()) {
  const ref = accountRef(accountId);
  const records = rows.filter((row) => row?.accountRef === ref || row?.malformed);
  let previousHash = ZERO_HASH;
  let sequence = 0;
  for (const row of records) {
    sequence += 1;
    if (row?.malformed || row.version !== 1 || row.sequence !== sequence || row.previousHash !== previousHash) {
      return { ok: false, count: sequence - 1, error: `receipt chain invalid at sequence ${sequence}` };
    }
    const payload = {
      action: row.action, outcome: row.outcome, mode: row.mode,
      order: row.order, market: row.market, execution: row.execution,
      authorization: row.authorization, policy: row.policy, latency: row.latency,
    };
    // Portfolio risk was added after the v1 chain launched. Include it only
    // when present so receipts written by older releases remain verifiable.
    if (row.portfolioRisk !== undefined) payload.portfolioRisk = row.portfolioRisk;
    if (row.payloadHash !== sha256(payload)) return { ok: false, count: sequence - 1, error: `receipt payload mismatch at sequence ${sequence}` };
    const envelope = {
      version: row.version, receiptId: row.receiptId, accountRef: row.accountRef,
      sequence: row.sequence, recordedAt: row.recordedAt,
      previousHash: row.previousHash, payloadHash: row.payloadHash,
    };
    if (row.hash !== sha256(envelope)) return { ok: false, count: sequence - 1, error: `receipt hash mismatch at sequence ${sequence}` };
    previousHash = row.hash;
  }
  return { ok: true, count: sequence, headHash: previousHash };
}

export function marketEvidence({ ticker = null, requestedEntry = null, side = 'long', size = null, now = Date.now() } = {}) {
  const observedPrice = finite(ticker?.last);
  const bid = finite(ticker?.bid);
  const ask = finite(ticker?.ask);
  const entry = finite(requestedEntry);
  const units = finite(size);
  const midpoint = bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : observedPrice;
  const spreadBps = midpoint && bid != null && ask != null ? ((ask - bid) / midpoint) * 10_000 : null;
  const deviationBps = observedPrice && entry
    ? (side === 'short' ? (observedPrice - entry) : (entry - observedPrice)) / observedPrice * 10_000
    : null;
  const notional = entry && units ? entry * units : null;
  const integrity = ticker?.quoteIntegrity || {};
  return {
    available: observedPrice != null && observedPrice > 0,
    source: clean(ticker?.source || '', 80) || null,
    observedPrice: round(observedPrice, 8),
    observedAt: Number.isSafeInteger(Number(ticker?.observedAt)) ? Number(ticker.observedAt) : null,
    quoteAgeMs: Number.isFinite(Number(ticker?.ageMs)) ? Math.max(0, Math.trunc(Number(ticker.ageMs))) : null,
    fresh: ticker?.fresh === true,
    bid: round(bid, 8),
    ask: round(ask, 8),
    spreadBps: round(spreadBps, 2),
    entryDeviationBps: round(deviationBps, 2),
    entryDeviationUsd: round(notional != null && deviationBps != null ? notional * deviationBps / 10_000 : null, 4),
    quoteIntegrity: {
      required: integrity.required === true,
      quorumMet: integrity.quorumMet === true,
      minimumVenues: Number.isSafeInteger(Number(integrity.minimumVenues)) ? Number(integrity.minimumVenues) : null,
      quoteCount: Number.isSafeInteger(Number(integrity.quoteCount)) ? Number(integrity.quoteCount) : null,
      trustedVenueCount: Number.isSafeInteger(Number(integrity.trustedVenueCount)) ? Number(integrity.trustedVenueCount) : null,
      excludedVenueCount: Number.isSafeInteger(Number(integrity.excludedVenueCount)) ? Number(integrity.excludedVenueCount) : null,
      consensusPrice: round(integrity.consensusPrice, 8),
      maximumOutlierBps: round(integrity.maximumOutlierBps, 2),
      maximumVenueSpreadBps: round(integrity.maximumVenueSpreadBps, 2),
      maximumObservedDeviationBps: round(integrity.maximumObservedDeviationBps, 2),
      routeVenue: clean(integrity.routeVenue, 80) || null,
      routeLatencyMs: Number.isFinite(Number(integrity.routeLatencyMs)) ? Math.max(0, Math.trunc(Number(integrity.routeLatencyMs))) : null,
      executionSide: integrity.executionSide === 'bid' ? 'bid' : 'ask',
      excludedVenues: Array.isArray(integrity.excludedVenues) ? integrity.excludedVenues.slice(0, 8).map((venue) => ({
        source: clean(venue?.source, 80) || 'unknown', reason: clean(venue?.reason, 80) || 'excluded',
      })) : [],
      venues: Array.isArray(integrity.venues) ? integrity.venues.slice(0, 8).map((venue) => ({
        source: clean(venue?.source, 80) || 'unknown',
        bid: round(venue?.bid, 8), ask: round(venue?.ask, 8),
        observedAt: Number.isSafeInteger(Number(venue?.observedAt)) ? Number(venue.observedAt) : null,
        ageMs: Number.isFinite(Number(venue?.ageMs)) ? Math.max(0, Math.trunc(Number(venue.ageMs))) : null,
        latencyMs: Number.isFinite(Number(venue?.latencyMs)) ? Math.max(0, Math.trunc(Number(venue.latencyMs))) : null,
        consensusDeviationBps: round(venue?.consensusDeviationBps, 2),
        spreadBps: round(venue?.spreadBps, 2),
      })) : [],
    },
    capturedAt: Math.trunc(now),
  };
}

function sanitizedPayload(input, accountId) {
  const request = input.request || {};
  const execution = input.execution || {};
  const authorization = input.authorization || {};
  const latency = input.latency || {};
  const payload = {
    action: input.action === 'close' ? 'close' : 'open',
    outcome: ['accepted', 'rejected', 'reversed'].includes(input.outcome) ? input.outcome : 'rejected',
    mode: 'paper-only',
    order: {
      symbol: clean(request.symbol, 24).toUpperCase(),
      side: request.side === 'short' ? 'short' : 'long',
      size: round(request.size, 8),
      requestedEntry: round(request.requestedEntry, 8),
      requestedNotionalUsd: round(request.requestedNotionalUsd, 2),
      confidence: round(request.confidence, 2),
      reasoningSummary: redactReason(request.reasoningSummary),
      missionAttached: request.missionAttached === true,
      missionRef: opaqueRef('mission', request.missionId),
      positionRef: opaqueRef('paper-position', request.positionId),
      intentProtected: request.intentProtected === true,
      intentRef: request.intentId ? executionIntentRef(accountId, request.intentId) : null,
      preflightProtected: request.preflightProtected === true,
      preflightFingerprint: /^[a-f0-9]{64}$/.test(String(request.preflightFingerprint || ''))
        ? request.preflightFingerprint : null,
    },
    market: input.market || marketEvidence(),
    execution: {
      status: clean(execution.status, 40) || 'not-filled',
      simulated: true,
      fillPrice: round(execution.fillPrice, 8),
      fillAuthority: clean(execution.fillAuthority, 80) || null,
      fillVenue: clean(execution.fillVenue, 80) || null,
      maxSlippageBps: round(execution.maxSlippageBps, 2),
      slippageBps: round(execution.slippageBps, 2),
      slippageUsd: round(execution.slippageUsd, 4),
      priceImprovementUsd: round(execution.priceImprovementUsd, 4),
      feeUsd: round(execution.feeUsd ?? 0, 4),
      feeModel: clean(execution.feeModel || 'paper-zero-fee', 80),
      pnlUsd: round(execution.pnlUsd, 2),
      result: ['win', 'loss', 'breakeven'].includes(execution.result) ? execution.result : null,
    },
    authorization: {
      principal: ['human-session', 'user-agent', 'platform-agent'].includes(authorization.principal) ? authorization.principal : 'human-session',
      tradePaperScope: authorization.tradePaperScope === true,
      walletPactRequired: authorization.walletPactRequired === true,
      walletPactAuthorized: authorization.walletPactAuthorized === true,
      missionRequired: authorization.missionRequired === true,
      missionAuthorized: authorization.missionAuthorized === true,
      preflightRequired: authorization.preflightRequired === true,
      preflightAuthorized: authorization.preflightAuthorized === true,
      liveScopeUsed: false,
      publicChainUsed: false,
    },
    policy: {
      decision: input.policy?.decision === 'allow' ? 'allow' : 'deny',
      reasonCode: clean(input.policy?.reasonCode, 120) || null,
      detail: clean(input.policy?.detail, 240) || null,
    },
    latency: {
      totalMs: Math.max(0, Math.trunc(finite(latency.totalMs) || 0)),
      authorizationMs: Math.max(0, Math.trunc(finite(latency.authorizationMs) || 0)),
      brokerMs: Math.max(0, Math.trunc(finite(latency.brokerMs) || 0)),
      settlementMs: Math.max(0, Math.trunc(finite(latency.settlementMs) || 0)),
    },
  };
  if (input.portfolioRisk) {
    const risk = input.portfolioRisk;
    const policy = risk.policy || {};
    const metrics = risk.metrics || {};
    payload.portfolioRisk = {
      decision: risk.decision === 'allow' ? 'allow' : 'deny',
      reasonCode: clean(risk.reasonCode, 120) || null,
      policy: {
        maxOrderPct: round(policy.maxOrderPct),
        maxGrossExposurePct: round(policy.maxGrossExposurePct),
        maxSymbolExposurePct: round(policy.maxSymbolExposurePct),
        maxCorrelatedExposurePct: round(policy.maxCorrelatedExposurePct),
        maxDrawdownPct: round(policy.maxDrawdownPct),
        maxDailyRealizedLossPct: round(policy.maxDailyRealizedLossPct),
        maxRiskAtStopPct: round(policy.maxRiskAtStopPct),
        maxOpenPositions: Number.isSafeInteger(Number(policy.maxOpenPositions)) ? Number(policy.maxOpenPositions) : null,
        stormMaxOrderPct: round(policy.stormMaxOrderPct),
      },
      metrics: {
        currentEquityUsd: round(metrics.currentEquityUsd),
        orderNotionalUsd: round(metrics.orderNotionalUsd),
        orderPct: round(metrics.orderPct),
        projectedGrossExposurePct: round(metrics.projectedGrossExposurePct),
        projectedSymbolExposurePct: round(metrics.projectedSymbolExposurePct),
        correlatedGroup: clean(metrics.correlatedGroup, 40) || null,
        projectedCorrelatedExposurePct: round(metrics.projectedCorrelatedExposurePct),
        projectedOpenPositions: Number.isSafeInteger(Number(metrics.projectedOpenPositions)) ? Number(metrics.projectedOpenPositions) : null,
        drawdownPct: round(metrics.drawdownPct),
        dailyRealizedLossPct: round(metrics.dailyRealizedLossPct),
        protectiveStopRequired: metrics.protectiveStopRequired === true,
        protectiveStopPresent: metrics.protectiveStopPresent === true,
        protectiveStopValid: metrics.protectiveStopValid === true,
        riskAtStopPct: round(metrics.riskAtStopPct),
        volatilityRegime: ['calm', 'normal', 'storm'].includes(metrics.volatilityRegime) ? metrics.volatilityRegime : null,
      },
      checks: Array.isArray(risk.checks) ? risk.checks.slice(0, 20).map((check) => ({
        code: clean(check?.code, 80) || 'unknown', pass: check?.pass === true,
      })) : [],
    };
  }
  return payload;
}

export function recordExecutionReceipt({ accountId, now = Date.now(), ...input }) {
  if (!accountId) throw new Error('receipt account required');
  const rows = readRows();
  const verified = verifyReceiptChain(accountId, rows);
  if (!verified.ok) throw new Error(verified.error);
  const payload = sanitizedPayload(input, accountId);
  const envelope = {
    version: 1,
    receiptId: `xrc_${Math.trunc(now).toString(36)}${crypto.randomBytes(5).toString('hex')}`,
    accountRef: accountRef(accountId),
    sequence: verified.count + 1,
    recordedAt: Math.trunc(now),
    previousHash: verified.headHash,
    payloadHash: sha256(payload),
  };
  const row = { ...envelope, ...payload, hash: sha256(envelope) };
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(FILE, 0o600);
  return structuredClone(row);
}

export function listExecutionReceipts(accountId, limit = 50) {
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), MAX_LIST);
  const rows = readRows();
  const verification = verifyReceiptChain(accountId, rows);
  if (!verification.ok) return { ok: false, mode: 'paper-only', verification, receipts: [] };
  const ref = accountRef(accountId);
  const receipts = rows.filter((row) => row.accountRef === ref).slice(-bounded).reverse();
  return { ok: true, mode: 'paper-only', verification, receipts: structuredClone(receipts) };
}

export function secureReceiptPermissions() {
  if (existsSync(FILE)) chmodSync(FILE, 0o600);
}
