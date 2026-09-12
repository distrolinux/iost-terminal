import assert from 'node:assert/strict';
import { previewSpotLedgerEvidence } from '../lib/live-settlement-evidence.js';
const expected = { referenceId: 'T-FIXTURE', baseAsset: 'XXBT', quoteAsset: 'ZUSD', side: 'buy', volume: '0.001', cost: '50' };
const rows = [
  { id: 'L-BASE', refid: 'T-FIXTURE', type: 'trade', subtype: '', aclass: 'currency', asset: 'XXBT', amount: '0.001', fee: '0.000001' },
  { id: 'L-QUOTE', refid: 'T-FIXTURE', type: 'trade', subtype: '', aclass: 'currency', asset: 'ZUSD', amount: '-50', fee: '0' }
];
const result = previewSpotLedgerEvidence(expected, rows);
assert.equal(result.status, 'ledger-legs-matched');
assert.deepEqual(result.assets, [
  { asset: 'XXBT', amount: '0.001', fee: '0.000001', netChange: '0.000999' },
  { asset: 'ZUSD', amount: '-50', fee: '0', netChange: '-50' }
]);
assert.equal(result.settlementVerified, false);
assert.equal(result.releaseAllowed, false);
assert.equal(result.executionAuthorized, false);
assert.deepEqual(previewSpotLedgerEvidence(expected, [...rows].reverse()), result);
for (const change of [
  r => r.pop(), r => r.push({ ...r[0] }), r => r[0].id = r[1].id,
  r => r[0].refid = 'T-OTHER', r => r[0].asset = 'KFEE',
  r => r[0].amount = '0.002', r => r[1].amount = '50',
  r => r[0].fee = '-0.1', r => r[0].fee = 0,
  r => r[0].fee = '1e-8', r => r[0].fee = '0.00000000001',
  r => r[0].type = 'margin', r => r[0].subtype = 'unknown',
  r => r[0].aclass = 'other'
]) {
  const copy = structuredClone(rows); change(copy);
  assert.equal(previewSpotLedgerEvidence(expected, copy).status, 'unknown');
}
const sell = structuredClone(rows); sell[0].amount = '-0.001'; sell[1].amount = '50'; sell[0].fee = '0'; sell[1].fee = '0.1';
assert.equal(previewSpotLedgerEvidence({ ...expected, side: 'sell' }, sell).assets[1].netChange, '49.9');
assert.equal(previewSpotLedgerEvidence({ ...expected, baseAsset: 'ZUSD' }, rows).status, 'unknown');
assert.equal(previewSpotLedgerEvidence(null, null).status, 'unknown');
console.log('Spot ledger evidence preview: passed (offline; settlement remains unverified)');
