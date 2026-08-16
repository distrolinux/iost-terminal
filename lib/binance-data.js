// lib/binance-data.js — Binance Web3 public-data adapters (Token Audit + Smart-Money Signals)
// v1.16 — added 2026-08-11 from binance-token-audit / binance-trading-signal skills.
// Public APIs only (no keys). Server-side proxy so the browser never talks to Binance directly.

import { randomUUID } from 'node:crypto';

const BINANCE = 'https://web3.binance.com/bapi/defi/v1/public';
const TIMEOUT_MS = 10_000;
const UA = { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/2.0 (Skill)' };

export const AUDIT_CHAINS = [
  { id: '56', name: 'BSC' },
  { id: '8453', name: 'Base' },
  { id: 'CT_501', name: 'Solana' },
  { id: '1', name: 'Ethereum' },
];
export const SIGNAL_CHAINS = [
  { id: '56', name: 'BSC' },
  { id: 'CT_501', name: 'Solana' },
];

async function post(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...UA, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const LOGO_PREFIX = 'https://bin.bnbstatic.com';

// ---------- Token Audit ----------

export function normalizeAudit(raw) {
  // raw = response.data of the token/audit endpoint (or null)
  if (!raw || !raw.hasResult || !raw.isSupported) {
    return { ok: true, supported: false, hasResult: false };
  }
  let levelEnum = String(raw.riskLevelEnum || '').toUpperCase();
  const level = raw.riskLevel ?? null;
  // API sometimes omits the enum but always sends the numeric level — derive it
  if (!levelEnum && level != null) {
    levelEnum = level <= 1 ? 'LOW' : level <= 3 ? 'MEDIUM' : 'HIGH';
  }
  const items = (raw.riskItems || []).map((cat) => ({
    id: cat.id,
    name: cat.name,
    description: cat.description || '',
    checks: (cat.details || []).map((d) => ({
      title: d.title,
      description: d.description || '',
      hit: !!d.isHit,
      type: d.riskType === 'RISK' ? 'risk' : 'caution',
    })),
  }));
  let hits = 0;
  let cautions = 0;
  for (const cat of items) for (const c of cat.checks) { if (c.hit) c.type === 'risk' ? hits++ : cautions++; }
  return {
    ok: true,
    supported: true,
    hasResult: true,
    riskLevel: level,
    riskLevelEnum: levelEnum === 'MID' ? 'MEDIUM' : levelEnum || 'UNKNOWN', // API says MID; skill says MEDIUM
    buyTax: raw.extraInfo?.buyTax ?? null,
    sellTax: raw.extraInfo?.sellTax ?? null,
    isVerified: raw.extraInfo?.isVerified ?? null,
    source: raw.extraInfo?.source || 'BINANCE',
    hits,
    cautions,
    items,
  };
}

export async function auditToken(contractAddress, chainId) {
  const body = {
    binanceChainId: String(chainId),
    contractAddress: String(contractAddress).trim(),
    requestId: randomUUID(),
  };
  const out = await post(`${BINANCE}/wallet-direct/security/token/audit`, body);
  if (out?.code !== '000000' || !out?.data) {
    throw new Error(`Token audit failed (code ${out?.code ?? 'n/a'})`);
  }
  return normalizeAudit(out.data);
}

// ---------- Smart-Money Signals ----------

export function normalizeSignals(raw) {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  return list.map((s) => {
    const maxGainRaw = parseFloat(s.maxGain);
    const maxGainPct = Number.isFinite(maxGainRaw) ? Math.round(maxGainRaw * 10000) / 100 : null;
    const tags = [];
    for (const group of Object.values(s.tokenTag || {})) {
      for (const t of group || []) if (t?.tagName) tags.push(t.tagName);
    }
    return {
      signalId: s.signalId,
      ticker: s.ticker,
      chainId: s.chainId,
      contractAddress: s.contractAddress,
      logoUrl: s.logoUrl ? (s.logoUrl.startsWith('http') ? s.logoUrl : LOGO_PREFIX + s.logoUrl) : null,
      chainLogoUrl: s.chainLogoUrl || null,
      isAlpha: !!s.isAlpha,
      launchPlatform: s.launchPlatform || null,
      direction: s.direction === 'sell' ? 'sell' : 'buy',
      smartMoneyCount: s.smartMoneyCount ?? 0,
      signalCount: s.signalCount ?? 0,
      triggerTime: s.signalTriggerTime ?? null,
      timeFrame: s.timeFrame ?? null,
      alertPrice: s.alertPrice ?? null,
      currentPrice: s.currentPrice ?? null,
      alertMarketCap: s.alertMarketCap ?? null,
      currentMarketCap: s.currentMarketCap ?? null,
      highestPrice: s.highestPrice ?? null,
      totalTokenValue: s.totalTokenValue ?? null,
      maxGainPct,
      exitRate: s.exitRate ?? null,
      status: s.status || 'unknown',
      tags: tags.slice(0, 5),
    };
  });
}

// 30s in-memory cache per (chain, page) — the feed is bursty, cache keeps it snappy
const signalCache = new Map();
const SIGNAL_CACHE_MS = 30_000;

export async function smartMoney({ chainId = '56', page = 1, pageSize = 20 } = {}) {
  const key = `${chainId}:${page}:${pageSize}`;
  const hit = signalCache.get(key);
  if (hit && Date.now() - hit.ts < SIGNAL_CACHE_MS) return hit.value;
  const body = { chainId: String(chainId), page: Number(page), pageSize: Math.min(Number(pageSize) || 20, 100) };
  const out = await post(`${BINANCE}/wallet-direct/buw/wallet/web/signal/smart-money/ai`, body);
  if (out?.code !== '000000') throw new Error(`Smart-money feed failed (code ${out?.code ?? 'n/a'})`);
  const value = { ts: Date.now(), signals: normalizeSignals(out) };
  signalCache.set(key, { ts: Date.now(), value });
  return value;
}

export function signalCacheSize() { return signalCache.size; }
