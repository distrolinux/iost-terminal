// scripts/verify-payments.mjs — AUTO-CONFIRM pending credit payments.
// For each pending payment, verify its txid on-chain (IOST RPC for IOST
// assets, Tronscan API for USDT TRC20). Verified → credits granted + audit.
// Watchdog-style: prints ONLY when something changed; silent otherwise.
// Run: node scripts/verify-payments.mjs (wrapped by .hermes/scripts cron shim)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFeeConfig } from '../lib/fees.js';
import { listPayments, confirmPayment } from '../lib/payments.js';
import { getAccount, persistAccounts } from '../lib/paper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IOST_RPC = 'https://api.iost.io';
const TRC20_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function jsonPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function jsonGet(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  return r.json();
}

/** Verify an IOST transfer tx: token.iost transfer action to `address`. */
export async function verifyIost(txid, address) {
  try {
    const tx = await jsonGet(`${IOST_RPC}/getTxByHash/${encodeURIComponent(txid)}/true`);
    for (const a of tx?.actions || []) {
      if (a.contract === 'token.iost' && a.action_name === 'transfer') {
        const d = JSON.parse(a.data || '{}');
        if (d.to === address && (d.tokenSymbol || '').toLowerCase() === 'iost')
          return { ok: true, symbol: d.tokenSymbol, amount: d.amount };
      }
    }
  } catch { /* network — leave pending */ }
  return { ok: false };
}

/** Verify a TRC20 USDT transfer tx to `address`. */
export async function verifyTrc20(txid, address) {
  try {
    const info = await jsonGet(`https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(txid)}`);
    const c = info?.contractData || {};
    if (c.contract_address === TRC20_USDT && c.to_address === address)
      return { ok: true, symbol: 'USDT_TRC20', amount: (c.amount || 0) / 1e6 };
    const t = info?.tokenTransferInfo || {};
    if (t.contract_address === TRC20_USDT && t.to_address === address)
      return { ok: true, symbol: 'USDT_TRC20', amount: parseFloat(t.amount_str || t.amount || 0) };
  } catch { /* leave pending */ }
  return { ok: false };
}

/** Verify a BTC tx: any output pays `address`. Keyless via blockchain.info. */
export async function verifyBtc(txid, address) {
  try {
    const info = await jsonGet(`https://blockchain.info/rawtx/${encodeURIComponent(txid)}`);
    for (const out of info?.out || []) {
      if (out.addr === address) return { ok: true, symbol: 'BTC', amount: (out.value || 0) / 1e8 };
    }
  } catch { /* leave pending */ }
  return { ok: false };
}

async function main() {
  const wallet = getFeeConfig().wallet || {};
  const pending = listPayments({ status: 'pending' });
  if (!pending.length) return; // silent
  const changed = [];
  for (const p of pending) {
    const address = wallet[p.asset];
    if (!address) continue; // no address configured — leave for manual confirm
    const res = p.asset === 'IOST'
      ? await verifyIost(p.txRef, address)
      : p.asset === 'BTC'
        ? await verifyBtc(p.txRef, address)
        : { ok: false }; // ETH/SOL/BNB: manual confirm until chain verifiers added
    if (res.ok) {
      const c = confirmPayment(p.id, getAccount, `auto-verified on-chain (${res.symbol} ${res.amount})`);
      if (c.ok) { persistAccounts(); changed.push(`${p.id} +${c.credits}cr (${res.symbol} ${res.amount})`); }
    }
  }
  if (changed.length) {
    console.log(`✅ AUTO-CONFIRMED ${changed.length} payment(s):`);
    changed.forEach(x => console.log('  ' + x));
  }
}

main().catch(e => console.log(`⚠️ verify-payments error: ${e.message}`));
