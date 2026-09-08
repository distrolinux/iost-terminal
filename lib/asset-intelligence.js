// Read-only Asset Intelligence Workspace projection. This module deliberately
// composes evidence; it never recommends, authorizes, reserves or executes.

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));

function safeHeadline(item = {}) {
  return {
    title: String(item.title || '').slice(0, 240),
    source: String(item.source || '').slice(0, 80),
    url: /^https:\/\//i.test(String(item.url || '')) ? String(item.url) : '',
    ts: finite(item.ts),
    sentiment: ['bullish', 'bearish', 'neutral'].includes(item.sentiment) ? item.sentiment : 'neutral',
    provenanceVerified: item.dataTrust?.provenanceHashed === true || !!item.dataTrust?.provenanceHash,
    quarantined: item.dataTrust?.quarantined === true,
  };
}

export function buildAssetIntelligence({ symbol, analysis, score, probability = null, news = null, now = Date.now() } = {}) {
  if (!analysis || !score) throw new Error('analysis and score evidence are required');
  const normalized = String(symbol || analysis.symbol || '').toUpperCase().trim();
  if (!normalized || normalized !== String(analysis.symbol || '').toUpperCase()) throw new Error('symbol evidence mismatch');

  const assetNews = news?.byAsset?.[normalized] || null;
  const headlines = (assetNews?.latest || [])
    .map(safeHeadline)
    .filter((item) => item.title && !item.quarantined)
    .slice(0, 6);
  const allRelevant = (news?.items || []).filter((item) => item?.assets?.includes(normalized));
  const quarantinedCount = allRelevant.filter((item) => item?.dataTrust?.quarantined).length;
  const provenanceCount = headlines.filter((item) => item.provenanceVerified).length;
  const observedAt = finite(analysis.ts);
  const ageMs = observedAt == null ? null : Math.max(0, now - observedAt);

  return {
    ok: true,
    mode: 'intelligence-only',
    version: 1,
    symbol: normalized,
    type: analysis.type === 'stock' ? 'stock' : 'crypto',
    generatedAt: now,
    market: {
      price: finite(analysis.price),
      change24hPct: finite(analysis.change24hPct),
      high24h: finite(analysis.high24h),
      low24h: finite(analysis.low24h),
      volume24hQuote: finite(analysis.vol24hQuote),
      source: String(analysis.source || 'server market feed').slice(0, 80),
      observedAt,
      ageMs,
      fresh: ageMs != null && ageMs <= 60_000,
      bias: String(analysis.biasLabel || 'Neutral'),
    },
    score: {
      composite: clamp(finite(score.composite) ?? 50),
      evidenceBand: score.composite >= 80 ? 'Very strong' : score.composite >= 65 ? 'Strong' : score.composite >= 50 ? 'Mixed-positive' : score.composite >= 35 ? 'Mixed-negative' : 'Weak',
      subscores: Object.fromEntries(Object.entries(score.subscores || {}).map(([key, value]) => [key, clamp(finite(value) ?? 50)])),
      weights: score.weights || {},
      recommendation: false,
    },
    probability: probability ? {
      up: finite(probability.probUp),
      down: finite(probability.probDown),
      direction: String(probability.direction || 'neutral'),
      intervalLow: finite(probability.ciLo),
      intervalHigh: finite(probability.ciHi),
      methodology: 'deterministic score-derived estimate; not a forecast guarantee',
    } : null,
    technicals: {
      rsi: finite(analysis.indicators?.rsi),
      atrPct: finite(analysis.indicators?.atrPct),
      volumeZScore: finite(analysis.indicators?.volZ),
      support: finite(analysis.indicators?.support),
      resistance: finite(analysis.indicators?.resistance),
      movingAverageState: analysis.indicators?.maState || null,
      signals: (analysis.signals || []).slice(0, 12).map((signal) => ({
        label: String(signal.label || '').slice(0, 100),
        direction: String(signal.direction || 'neutral'),
        detail: String(signal.detail || '').slice(0, 160),
      })),
    },
    activity: {
      largeTradeCount: Math.max(0, Math.trunc(finite(analysis.whale?.bigTrades24h) ?? 0)),
      largestTradeUsd: Math.max(0, finite(analysis.whale?.largestUsd) ?? 0),
      recent: (analysis.whale?.alerts || []).slice(0, 5).map((trade) => ({
        ts: finite(trade.ts), side: trade.side === 'sell' ? 'sell' : 'buy',
        price: finite(trade.price), size: finite(trade.size), usd: finite(trade.usd), source: String(trade.source || '').slice(0, 80),
      })),
    },
    sentiment: {
      label: score.components?.newsLabel || 'neutral',
      score: clamp(finite(score.subscores?.news) ?? 50),
      coverage: Math.max(0, Math.trunc(finite(assetNews?.total) ?? 0)),
      bullish: Math.max(0, Math.trunc(finite(assetNews?.bullish) ?? 0)),
      bearish: Math.max(0, Math.trunc(finite(assetNews?.bearish) ?? 0)),
      headlines,
    },
    evidence: {
      marketAvailable: finite(analysis.price) != null,
      scoreAvailable: finite(score.composite) != null,
      newsCoverage: headlines.length,
      provenanceCoveragePct: headlines.length ? Math.round((provenanceCount / headlines.length) * 100) : 100,
      quarantinedCount,
      externalContentAuthority: 'data-only',
      suspiciousContentHandling: 'quarantine-and-exclude',
    },
    boundaries: {
      readOnly: true,
      executionAuthority: 'none',
      recommendation: false,
      requiresFreshPreflightForExecution: true,
      requiresAgentPermissions: true,
      requiresWalletPactAuthorization: true,
      humanApprovalMayBeRequired: true,
      contractAudit: 'requires-verified-contract-address',
      executionAttempted: false,
      reservationCreated: false,
      receiptCreated: false,
      tradeCreated: false,
      authorityExpanded: false,
      liveScopeUsed: false,
      publicChainUsed: false,
    },
  };
}
