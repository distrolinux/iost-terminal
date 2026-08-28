// lib/onchain.js — IOST blockchain dashboard via the configured operator node
// or the public api.iost.io fallback.
import { getTicker } from './market.js';
import { IOST_RPC, deriveIostNodeHealth, iostNodePublicConfig } from './iost-node.js';

const cache = { ts: 0, val: null, activity: new Map() };
const TTL = 30_000;

async function rpc(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${IOST_RPC}${path}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function parseTransfer(action) {
  if (!(action.contract === 'token.iost' && action.action_name === 'transfer')) return null;
  try {
    const d = JSON.parse(action.data);
    if (d.tokenSymbol === 'iost' && d.amount != null) {
      return { from: d.from, to: d.to, amount: +d.amount };
    }
  } catch { /* not JSON transfer */ }
  return null;
}

export async function getChainSnapshot(force = false) {
  if (cache.val && Date.now() - cache.ts < TTL && !force) return cache.val;

  const rpcStarted = Date.now();
  const [nodeResult, chainResult] = await Promise.allSettled([rpc('/getNodeInfo'), rpc('/getChainInfo')]);
  const nodeInfo = nodeResult.status === 'fulfilled' ? nodeResult.value : null;
  const chainInfo = chainResult.status === 'fulfilled' ? chainResult.value : null;
  const node = { ...iostNodePublicConfig(), ...deriveIostNodeHealth(chainInfo, nodeInfo, Date.now(), Date.now() - rpcStarted) };

  const headBlock = chainInfo?.head_block != null ? +chainInfo.head_block : 0;
  const netName = chainInfo?.net_name ?? 'Mainnet';
  const peerCount = nodeInfo?.network?.peer_count ?? null;

  // walk back recent blocks (parallel)
  let txCount = 0;
  const addresses = new Set();
  const largeTxs = [];
  const series = [];
  const span = Math.min(15, headBlock);
  const heights = [];
  for (let n = Math.max(1, headBlock - span); n <= headBlock; n++) heights.push(n);
  const blocks = (await Promise.all(heights.map(n =>
    rpc(`/getBlockByNumber/${n}/true`).catch(() => null)
  ))).filter(Boolean);

  for (const raw of blocks) {
    const b = raw.block || raw;
    const txs = b.transactions || [];
    const ts = b.time ? +b.time / 1e6 : Date.now();
    txCount += txs.length;
    series.push({ height: b.number != null ? +b.number : 0, ts, txs: txs.length });
    for (const tx of txs) {
      if (tx.publisher) addresses.add(tx.publisher);
      for (const act of tx.actions || []) {
        const tr = parseTransfer(act);
        if (tr && tr.amount > 0) {
          if (tr.from) addresses.add(tr.from);
          if (tr.to) addresses.add(tr.to);
          largeTxs.push({ hash: tx.hash, ts, from: tr.from, to: tr.to, amount: tr.amount });
        }
      }
    }
  }
  const times = series.map(s => s.ts).filter(Boolean);
  const firstTs = times.length ? Math.min(...times) : null;
  const lastTs = times.length ? Math.max(...times) : null;
  const elapsedSec = firstTs && lastTs && lastTs > firstTs ? (lastTs - firstTs) / 1000 : 1;
  const tps = txCount / Math.max(1, elapsedSec);
  const avgTxPerBlock = blocks.length ? txCount / blocks.length : 0;

  // price for USD conversion
  let price = null;
  try { price = (await getTicker('IOST')).last; } catch { /* no price */ }
  const topLargeTxs = largeTxs
    .map(t => ({ ...t, usd: price ? t.amount * price : null }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12);

  // gas / RAM / token
  let gasRatio = null, ramInfo = null, tokenInfo = null;
  try { gasRatio = await rpc('/getGasRatio'); } catch { /* optional */ }
  try { ramInfo = await rpc('/getRAMInfo'); } catch { /* optional */ }
  try { tokenInfo = await rpc('/getTokenInfo/iost'); } catch { /* optional */ }

  const snapshot = {
    chain: {
      netName, chainId: Number(chainInfo?.chain_id || 0), headBlock,
      libBlock: node.libBlock, finalityGapBlocks: node.finalityGapBlocks, finalityLagSec: node.finalityLagSec,
      peerCount,
      tps: Math.round(tps * 100) / 100,
      avgTxPerBlock: Math.round(avgTxPerBlock * 100) / 100,
      activeAddresses: addresses.size,
      sampleTransactions: txCount,
      sampleBlockCount: series.length,
      blockIntervalSec: series.length > 1 && lastTs > firstTs ? Math.round(((lastTs - firstTs) / 1000 / (series.length - 1)) * 10) / 10 : null,
    },
    token: {
      symbol: 'IOST', price,
      totalSupply: tokenInfo?.totalSupply ? +tokenInfo.totalSupply : null,
      inflationRate: tokenInfo?.inflationRate != null ? +tokenInfo.inflationRate : null,
    },
    gas: gasRatio ? { ratio: gasRatio?.median_gas_ratio ?? gasRatio?.lowest_gas_ratio ?? null } : null,
    ram: ramInfo ? { available: ramInfo?.available_ram ?? null, used: ramInfo?.used_ram ?? null, total: ramInfo?.total_ram ?? null, buyPrice: ramInfo?.buy_price ?? null } : null,
    series,
    largeTxs: topLargeTxs,
    node,
    fetchedAt: Date.now(),
    live: !!chainInfo,
  };

  // per-asset activity score (0-100)
  cache.activity.clear();
  const score = Math.round(Math.max(0, Math.min(100,
    50 + snapshot.chain.tps * 3 + snapshot.chain.activeAddresses * 1.5 + topLargeTxs.length * 4)));
  cache.activity.set('IOST', { score, tps: snapshot.chain.tps, activeAddresses: snapshot.chain.activeAddresses, largeTxCount: topLargeTxs.length, ts: Date.now() });

  cache.val = snapshot;
  cache.ts = Date.now();
  return snapshot;
}

// synchronous cached read for score engine (null for non-IOST)
export function getOnChainActivity(symbol) {
  if (symbol === 'IOST') return cache.activity.get('IOST') || null;
  return null;
}
