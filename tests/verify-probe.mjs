// Live probe: verify IOST + TRC20 verification functions against real chain data.
import { verifyIost, verifyTrc20 } from '../scripts/verify-payments.mjs';
import { getFeeConfig } from '../lib/fees.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ---- IOST: find a recent real transfer, then verify it ----
const rpc = 'https://api.iost.io';
async function findIostTransfer() {
  const chain = await (await fetch(`${rpc}/getChainInfo`)).json();
  const head = chain?.head_block ? +chain.head_block : 0;
  if (!head) return null;
  for (let i = 0; i < 30; i++) {
    const raw = await (await fetch(`${rpc}/getBlockByNumber/${head - i}/true`)).json();
    const blk = raw.block || raw;
    for (const tx of blk.transactions || []) {
      for (const a of tx.actions || []) {
        if (a.contract === 'token.iost' && a.action_name === 'transfer') {
          const d = JSON.parse(a.data || '{}');
          if (d.tokenSymbol === 'iost') return { txid: tx.hash, to: d.to };
        }
      }
    }
  }
  return null;
}
const iostTx = await findIostTransfer();
if (iostTx) {
  const v = await verifyIost(iostTx.txid, iostTx.to);
  ok('IOST verify real transfer', v.ok, `to ${iostTx.to.slice(0, 12)}…`);
} else {
  console.log('SKIP  IOST — no transfer found in recent blocks (retry later)');
}
const badIost = await verifyIost('bogus_txid_123', 'iost_whatever');
ok('IOST verify bogus tx → false', !badIost.ok);

// ---- TRC20: find a recent real USDT transfer, then verify it ----
try {
  const list = await (await fetch('https://apilist.tronscanapi.com/api/filter/trc20/transfers?limit=5&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).json();
  const t = list?.token_transfers?.[0];
  if (t) {
    const v = await verifyTrc20(t.transaction_id, t.to_address);
    ok('TRC20 verify real transfer', v.ok, `to ${t.to_address.slice(0, 8)}… amt ${v.amount ?? '?'}`);
  } else {
    console.log('SKIP  TRC20 — no transfers returned');
  }
} catch (e) { console.log(`SKIP  TRC20 — API error: ${e.message}`); }
const badTrc = await verifyTrc20('bogus_txid_456', 'Twhatever');
ok('TRC20 verify bogus tx → false', !badTrc.ok);

// wallet config sanity
console.log('configured wallet assets:', JSON.stringify(getFeeConfig().wallet));

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
