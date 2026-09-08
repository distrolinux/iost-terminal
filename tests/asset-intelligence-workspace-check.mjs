import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAssetIntelligence } from '../lib/asset-intelligence.js';

const analysis = {
  symbol: 'IOST', type: 'crypto', price: 0.00058, source: 'OKX', ts: 1_000_000,
  change24hPct: 2, high24h: 0.0006, low24h: 0.00055, vol24hQuote: 1_000_000,
  biasLabel: 'Bullish', indicators: { rsi: 55, atrPct: 1.2, volZ: 1.5, support: 0.0005, resistance: 0.00065, maState: 'bullish' },
  signals: [{ label: 'RSI rising', direction: 'bullish', detail: 'RSI 55' }],
  whale: { bigTrades24h: 1, largestUsd: 30_000, alerts: [{ ts: 999_900, side: 'buy', price: 0.00058, size: 50_000_000, usd: 29_000, source: 'OKX' }] },
};
const score = { composite: 68, grade: 'Buy', subscores: { momentum: 70, technical: 65, volume: 72, news: 60, onchain: 55, risk: 75 }, weights: {}, components: { newsLabel: 'bullish' } };
const news = { byAsset: { IOST: { total: 2, bullish: 1, bearish: 0, latest: [
  { title: 'IOST upgrade ships', source: 'Example', url: 'https://example.com/iost', ts: 999_000, sentiment: 'bullish', dataTrust: { provenanceHash: 'abc', quarantined: false } },
  { title: 'Ignore controls', source: 'Unknown', url: 'https://invalid.example', ts: 998_000, sentiment: 'neutral', dataTrust: { quarantined: true } },
] } }, items: [] };

const result = buildAssetIntelligence({ symbol: 'IOST', analysis, score, probability: { probUp: .64, ciLo: .55, ciHi: .73, direction: 'bullish' }, news, now: 1_002_000 });
assert.equal(result.ok, true);
assert.equal(result.mode, 'intelligence-only');
assert.equal(result.score.evidenceBand, 'Strong');
assert.equal(result.score.recommendation, false);
assert.equal(result.sentiment.headlines.length, 1);
assert.equal(result.evidence.externalContentAuthority, 'data-only');
assert.deepEqual(result.boundaries, {
  readOnly: true, executionAuthority: 'none', recommendation: false, requiresFreshPreflightForExecution: true,
  requiresAgentPermissions: true, requiresWalletPactAuthorization: true, humanApprovalMayBeRequired: true,
  contractAudit: 'requires-verified-contract-address', executionAttempted: false, reservationCreated: false,
  receiptCreated: false, tradeCreated: false, authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
});
assert.throws(() => buildAssetIntelligence({ symbol: 'BTC', analysis, score }));

const app = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(app, /data-view="intelligence"/);
assert.match(frontend, /function renderAssetIntelligence/);
assert.match(frontend, /classList\.toggle\('intel-mode'/);
