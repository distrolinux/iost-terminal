// tests/binance-data-check.mjs — smoke test for lib/binance-data.js (v1.16)
// Usage: node tests/binance-data-check.mjs   (network to web3.binance.com required)
// Verifies normalize functions on fixtures + live API calls. Exit 0 = pass.
import { normalizeAudit, normalizeSignals, auditToken, smartMoney, SIGNAL_CHAINS, AUDIT_CHAINS } from '../lib/binance-data.js';

let failures = 0;
const ok = (cond, label) => { if (!cond) { failures++; console.error(`FAIL: ${label}`); } else console.log(`ok: ${label}`); };

// --- normalizeAudit: unsupported / no result ---
const none = normalizeAudit(null);
ok(none.supported === false && none.hasResult === false, 'audit: null → unsupported');

// --- normalizeAudit: fixture (MID enum → MEDIUM) ---
const fx = {
  hasResult: true, isSupported: true, riskLevelEnum: 'MID', riskLevel: 3,
  extraInfo: { buyTax: '0', sellTax: '3.5', isVerified: true, source: 'BINANCE' },
  riskItems: [
    { id: 'CONTRACT_RISK', name: 'Contract Risk', description: 'x', details: [
      { title: 'Honeypot Risk Not Found', description: 'y', isHit: false, riskType: 'CAUTION' },
      { title: 'Ownership Renounced Not Found', description: 'z', isHit: true, riskType: 'RISK' },
    ]},
    { id: 'TRADE_RISK', name: 'Trade Risk', description: 'w', details: [
      { title: 'Sell Tax High', description: 'v', isHit: true, riskType: 'CAUTION' },
    ]},
  ],
};
const a = normalizeAudit(fx);
ok(a.supported && a.hasResult, 'audit: supported fixture');
ok(a.riskLevelEnum === 'MEDIUM', `audit: MID→MEDIUM (got ${a.riskLevelEnum})`);
ok(a.riskLevel === 3, 'audit: riskLevel 3');
ok(a.sellTax === '3.5' && a.buyTax === '0', 'audit: taxes kept as strings');
ok(a.isVerified === true, 'audit: verified flag');
ok(a.hits === 1 && a.cautions === 1, `audit: hit/caution counts (${a.hits}/${a.cautions})`);
ok(a.items.length === 2 && a.items[0].checks.length === 2, 'audit: items/checks grouped');

// --- normalizeAudit: enum omitted but numeric level present → derive ---
const fxNoEnum = { hasResult: true, isSupported: true, riskLevel: 5, extraInfo: {}, riskItems: [] };
const an = normalizeAudit(fxNoEnum);
ok(an.riskLevelEnum === 'HIGH' && an.riskLevel === 5, `audit: derived HIGH from level 5 (got ${an.riskLevelEnum})`);

// --- normalizeSignals: fixture (maxGain fraction → pct, logo prefix) ---
const sfx = { data: [
  { signalId: 1, ticker: 'TEST', chainId: '56', contractAddress: '0xabc', logoUrl: '/images/x.jpg', chainLogoUrl: 'https://chain/x.png',
    direction: 'buy', smartMoneyCount: 7, signalCount: 3, signalTriggerTime: 1720000000000, timeFrame: 3600000,
    alertPrice: '0.1', currentPrice: '0.12', highestPrice: '0.14', totalTokenValue: '50000',
    maxGain: '0.25', exitRate: 12, status: 'active',
    tokenTag: { 'Social Events': [{ tagName: 'DEX Paid' }], 'Launch Platform': [{ tagName: 'Pumpfun' }] } },
  { signalId: 2, ticker: 'TEST2', chainId: 'CT_501', contractAddress: '0xdef', direction: 'sell', smartMoneyCount: 2,
    alertPrice: '1', currentPrice: '0.9', maxGain: null, exitRate: 80, status: 'timeout', tokenTag: {} },
]};
const s = normalizeSignals(sfx);
ok(s.length === 2, 'signals: 2 normalized');
ok(s[0].maxGainPct === 25, `signals: maxGain 0.25 → 25% (got ${s[0].maxGainPct})`);
ok(s[0].logoUrl === 'https://bin.bnbstatic.com/images/x.jpg', 'signals: logoUrl prefix added');
ok(s[0].direction === 'buy' && s[1].direction === 'sell', 'signals: direction kept');
ok(s[0].tags.length === 2 && s[0].tags[0] === 'DEX Paid', 'signals: tags flattened');
ok(s[1].maxGainPct === null && s[1].status === 'timeout', 'signals: null maxGain + stale status');
ok(s[1].exitRate === 80, 'signals: exitRate kept');

// --- live calls ---
try {
  const live = await smartMoney({ chainId: '56', page: 1, pageSize: 3 });
  ok(Array.isArray(live.signals) && live.signals.length > 0, `live smart-money: ${live.signals.length} signals`);
  ok(typeof live.signals[0].ticker === 'string' && live.signals[0].signalId, 'live signal shape');
  const cached = await smartMoney({ chainId: '56', page: 1, pageSize: 3 });
  ok(cached.ts === live.ts, 'smart-money: 30s cache hit');
} catch (e) { failures++; console.error('FAIL: live smart-money:', e.message); }

try {
  const aud = await auditToken('0x55d398326f99059ff775485246999027b3197955', '56');
  ok(aud.supported || aud.hasResult === false, `live audit USDT/BSC: risk=${aud.riskLevelEnum} level=${aud.riskLevel}`);
} catch (e) { failures++; console.error('FAIL: live audit:', e.message); }

console.log(failures === 0 ? `\nPASS (${SIGNAL_CHAINS.length} signal chains, ${AUDIT_CHAINS.length} audit chains)` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
