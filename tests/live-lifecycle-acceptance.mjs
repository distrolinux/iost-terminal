// Release-blocking acceptance probe. Entirely offline: global fetch is replaced
// BEFORE broker import, fixture keys prevent .env fallback, state is temporary.
// Passing these limited regressions is not complete live lifecycle acceptance.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'iost-lifecycle-'));
process.env.IOST_DATA_DIR = scratch;
process.env.KRAKEN_API_KEY = 'offline-fixture-only';
process.env.KRAKEN_API_SECRET = Buffer.from('offline-fixture-only').toString('base64');
process.env.LIVE_TRADING_ENABLED = 'false';
process.env.PUBLIC_CHAIN_ACTIONS_ENABLED = 'false';
let handler = () => { throw Error('offline-unexpected-request'); }, calls = 0;
globalThis.fetch = async (url, options) => { calls++; return handler(String(url), options); };
let failures = 0;
const check = (name, condition) => { console.log(`${condition ? 'PASS' : 'BLOCKER'} ${name}`); if (!condition) failures++; };
const response = result => new Response(JSON.stringify({ error: [], result }));
try {
  const { createKrakenBroker } = await import('../lib/broker/kraken.js');
  const broker = createKrakenBroker();
  const order = { symbol: 'BTC', side: 'long', size: 0.0001, entry: 50000, clientOrderId: '12345678-1234-1234-1234-123456789abc' };
  let transport;
  handler = (url, options) => { assert.equal(url, 'https://api.kraken.com/0/private/AddOrder'); transport = options; return response({ txid: ['fixture-order'] }); };
  const accepted = await broker.placeOrder(order);
  check('accepted order is explicitly not a confirmed fill', accepted.order?.status === 'accepted' && accepted.order?.filledQuantity === undefined);
  check('submission has bounded timeout and refuses redirects', Boolean(transport.signal) && transport.redirect === 'error');
  check('stable client identity is sent', new URLSearchParams(transport.body).get('cl_ord_id') === order.clientOrderId);
  handler = () => response({});
  const missing = await broker.placeOrder(order);
  check('missing venue ID cannot be reported as success', missing.ok === false);
  calls = 0;
  handler = () => { throw Error('fixture timeout after possible acceptance'); };
  const timeout = await broker.placeOrder(order);
  check('timeout is explicitly outcome-unknown', timeout.outcome === 'unknown');
  check('adapter does not automatically retry timeout', calls === 1);
  handler = () => response({ open: { 'fixture-order': { vol: '1', vol_exec: '0.25', status: 'open', descr: { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '50000' } } } });
  const partial = await broker.getOrders();
  check('partial executed quantity is retained exactly', partial.orders?.[0]?.filledQuantity === '0.25');
  const proposals = await import('../lib/live-proposals.js');
  const p = proposals.addProposal({ userId: 'fixture-owner', symbol: 'BTC', side: 'long', size: 0.0001, entry: 50000 });
  check('first proposal obtains execution lease', proposals.claimForExecution(p.id, 'owner').ok);
  check('duplicate approval cannot obtain another lease', !proposals.claimForExecution(p.id, 'owner').ok);
  const reloaded = await import(`../lib/live-proposals.js?reload=${Date.now()}`);
  check('execution lease survives module reload from persisted store', !reloaded.claimForExecution(p.id, 'owner').ok && reloaded.getProposal(p.id).status === 'executing');
  check('unknown proposal remains unclaimable', reloaded.finalizeExecution(p.id, { status: 'unknown' }).ok && !reloaded.claimForExecution(p.id, 'owner').ok);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const execution = server.slice(server.indexOf('const r = await kraken.placeOrder'), server.indexOf("app.post('/api/trade/live'"));
  check('acceptance branch cannot synthesize fills or burn credits', !execution.includes('st.journal.push') && !execution.includes('burnCredits('));
  console.log(`Limited live regressions: ${failures} failed checks. Full lifecycle remains HOLD. No network or production data used.`);
  process.exitCode = failures ? 1 : 0;
} finally { rmSync(scratch, { recursive: true, force: true }); }
