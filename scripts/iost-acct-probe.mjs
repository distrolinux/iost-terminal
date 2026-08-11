// scripts/iost-acct-probe.mjs — no-spend ABI + wire-format probe for
// auth.iost/signUp (account creation) against the LIVE public RPC.
//
// Uses a THROWAWAY keypair as publisher: the node dry-runs the tx via /execTx
// (no consensus, no persistence, no cost). The receipt message is a diagnostic
// ladder — each stage passed proves the previous ones:
//   1. JSON unmarshal errors          → tx JSON shape wrong
//   2. "id existed > <name>"          → action + arg[0] parsed, name TAKEN
//   3. "id invalid..."                → action + arg[0] parsed, name rules violated
//   4. "require auth failed" (pledge) → name FREE + full wire format OK
//                                        (publisher is a nonexistent throwaway)
//   5. status_code SUCCESS            → full creation executed (needs funded pub)
//
// Run:  node scripts/iost-acct-probe.mjs
import { buildSignedTx, execTx, chainStatus } from '../lib/chain.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// throwaway publisher — never funded, never used for real txs
const kp = nacl.sign.keyPair();
const seedB58 = bs58.encode(kp.secretKey.slice(0, 32));
const pubB58 = bs58.encode(kp.publicKey);
const PUBLISHER = 'probeacct01'; // valid format, does not exist on-chain

async function probe(name, label) {
  const { body } = await buildSignedTx({
    actions: [{ contract: 'auth.iost', actionName: 'signUp', data: JSON.stringify([name, pubB58, pubB58]) }],
    amountLimit: [{ token: 'iost', value: '100' }],
    key: seedB58, account: PUBLISHER, gasRatio: 1, gasLimit: 1000000,
  });
  const r = await execTx(body);
  const rec = r.ok ? r.receipt : null;
  const status = rec?.status_code ?? 'NODE-ERROR';
  const message = (rec?.message || r.error || '').slice(0, 160);
  console.log(`\n[probe] ${label}`);
  console.log(`  name=${name} owner/active=${pubB58.slice(0, 12)}…`);
  console.log(`  status=${status}`);
  console.log(`  message=${message || '(empty)'}`);
  return { status, message };
}

const results = {};
results.taken = await probe('admin', 'name that EXISTS on mainnet');
results.free = await probe('zzprobe9001', 'name that is FREE (throwaway publisher)');
results.badname = await probe('BAD!name', 'INVALID name (uppercase + symbol)');
results.short = await probe('ab', 'INVALID name (too short)');
results.dupkey = await probe('zzprobe9001', 'same free name again (should repeat the ladder)');

const status = await chainStatus();
console.log('\n[probe] chain:', JSON.stringify({ ok: status.ok, headBlock: status.headBlock, configured: status.configured }));

// summary verdict
const verdicts = [];
if (/id existed/i.test(results.taken.message)) verdicts.push('name-exists check: WORKS (id existed error from signUp)');
if (/require auth failed/i.test(results.free.message) || results.free.status === 'SUCCESS') verdicts.push('free-name + wire format: VERIFIED (reached post-signUp stage / success)');
if (/id invalid/i.test(results.badname.message)) verdicts.push('name-rules enforcement: VERIFIED (id invalid error)');
console.log('\n[probe] verdicts:\n  - ' + verdicts.join('\n  - '));
