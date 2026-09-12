import assert from 'node:assert/strict';
import { combineKrakenReview } from '../lib/combined-kraken-review.js';
import { krakenSystemEvidence } from '../lib/kraken-draft-evidence.js';
const review = { createdAt: 1000, decision: 'not-authorized', accountFunding: { status: 'cash-indication-covers-estimate' }, policy: { notionalCap: 'within-configured-cap' }, order: { protectiveStop: '1' } };
const market = { status: 'public-checks-passed', expiresAt: 25000 };
const system = { status: 'online', emergencyCount: 0, maintenanceCount: 0, expiresAt: 20000 };
const check = (r = review, m = market, s = system, n = 2000) => combineKrakenReview(r, m, s, n);
assert.equal(check().expiresAt, 20000);
assert.equal(check().combined.status, 'checked-evidence-clear-not-authorized');
assert.equal(check().decision, 'not-authorized');
assert.equal(check().combined.executionAuthorized, false);
for (const status of ['maintenance', 'cancel_only', 'post_only', 'unknown', 'unavailable']) assert.equal(check(review, market, { ...system, status }).combined.checks.venueOnline, false);
assert.equal(check(review, market, { ...system, emergencyCount: 1 }).combined.checks.venueAdvisoriesClear, false);
assert.equal(check(review, market, system, 20000).combined.checks.fresh, false);
assert.equal(check(review, market, system, 999).combined.checks.fresh, false);
assert.equal(check(review, {}).combined.checks.fresh, false);
assert.equal(check({ ...review, accountFunding: {} }).combined.checks.cashEstimate, false);
assert.equal(check({ ...review, policy: {} }).combined.checks.notionalCap, false);
for (const data of [{ status: 'online', timestamp: new Date(10000).toISOString() }, { status: 'maintenance', timestamp: new Date(10000).toISOString() }]) {
  const r = await krakenSystemEvidence({ now: () => 10000, fetchFn: async (url, options) => {
    assert.equal(url, 'https://api.kraken.com/0/public/SystemStatus'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ error: [], result: data }));
  } }); assert.equal(r.status, data.status);
}
for (const data of [{ status: 'online' }, { status: 'online', timestamp: '2000-01-01' }, { status: 'online', timestamp: new Date(10000).toISOString(), emergency: 'invalid' }]) {
  assert.equal((await krakenSystemEvidence({ now: () => 10000, fetchFn: async () => new Response(JSON.stringify({ error: [], result: data })) })).status, 'unavailable');
}
console.log('Combined Kraken review checks passed');
