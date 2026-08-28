// Shared IOST L1 node configuration and public health derivation.
// RPC URLs can contain private hostnames or credentials, so public responses
// expose only a bounded operator label and whether the source is configured.
export const DEFAULT_IOST_RPC = 'https://api.iost.io';
export const IOST_RPC = String(process.env.IOST_RPC || DEFAULT_IOST_RPC).replace(/\/$/, '');

const IOSTCALLISTER_ACCOUNT = 'iost_4_life';
const IOSTCALLISTER_EXPLORER = 'https://iostscan.com/en/account/iost_4_life?activetab=0&listtab=0';
const IOST_PRODUCER_RANKING = 'https://iostscan.com/en/producers';

// Public, non-secret chain identity. Rank is deliberately not copied here:
// producer rankings change, so users and agents are sent to the live explorer.
const CHAIN_IDENTITY = Object.freeze({
  operator: Object.freeze({
    displayName: 'IOSTcallister',
    account: IOSTCALLISTER_ACCOUNT,
    role: 'IOST Layer 1 producer',
    country: 'Canada',
    verified: true,
    explorer: IOSTCALLISTER_EXPLORER,
    ranking: IOST_PRODUCER_RANKING,
    rankDynamic: true,
  }),
  layers: Object.freeze({
    l1: Object.freeze({
      name: 'IOST Layer 1',
      chainId: 1024,
      runtime: 'IOST V8VM',
      purpose: Object.freeze(['producer identity', 'network telemetry', 'signal hash anchoring']),
      rpcInterface: 'IOST REST/RPC',
      explorer: 'https://iostscan.com/en/',
    }),
    l2: Object.freeze({
      name: 'IOST Layer 2',
      chainId: 182,
      runtime: 'EVM / Solidity',
      purpose: Object.freeze(['AITT canonical token home', 'future agentic settlement']),
      rpcInterface: 'Ethereum JSON-RPC',
      rpc: 'https://l2-mainnet.iost.io',
      explorer: 'https://l2-scan.iost.io',
      token: Object.freeze({ symbol: 'AITT', status: 'pre-launch', issued: false, contractAddress: null }),
    }),
  }),
});

export function iostChainIdentity() {
  return structuredClone(CHAIN_IDENTITY);
}

const configured = Boolean(String(process.env.IOST_RPC || '').trim());
const rawLabel = String(process.env.IOST_NODE_LABEL || '').trim();
const safeLabel = rawLabel.replace(/[^a-zA-Z0-9 ._:-]/g, '').slice(0, 64);

export function iostNodePublicConfig() {
  return {
    source: configured ? 'operator-node' : 'public-rpc',
    label: safeLabel || (configured ? 'Operator IOST node' : 'IOST public RPC'),
    configured,
  };
}

function nsToMs(value) {
  try { return Number(BigInt(value) / 1_000_000n); } catch { return null; }
}

export function deriveIostNodeHealth(chainInfo, nodeInfo, now = Date.now(), responseMs = null) {
  const headBlock = Number(chainInfo?.head_block || 0);
  const libBlock = Number(chainInfo?.lib_block || 0);
  const headTimeMs = nsToMs(chainInfo?.head_block_time);
  const libTimeMs = nsToMs(chainInfo?.lib_block_time);
  const headAgeSec = headTimeMs == null ? null : Math.max(0, (now - headTimeMs) / 1000);
  const finalityLagSec = headTimeMs == null || libTimeMs == null ? null : Math.max(0, (headTimeMs - libTimeMs) / 1000);
  const finalityGapBlocks = headBlock && libBlock ? Math.max(0, headBlock - libBlock) : null;
  const peerCount = Number.isFinite(Number(nodeInfo?.network?.peer_count)) ? Number(nodeInfo.network.peer_count) : null;
  const expectedNetwork = Number(chainInfo?.chain_id) === 1024 && String(chainInfo?.net_name || '').toLowerCase() === 'mainnet';
  const fresh = headAgeSec != null && headAgeSec <= 30;
  const connected = peerCount != null && peerCount > 0;
  const status = !chainInfo ? 'offline' : (expectedNetwork && fresh && connected ? 'healthy' : 'degraded');

  return {
    status,
    expectedNetwork,
    fresh,
    headAgeSec: headAgeSec == null ? null : Math.round(headAgeSec * 10) / 10,
    headBlock,
    libBlock,
    finalityGapBlocks,
    finalityLagSec: finalityLagSec == null ? null : Math.round(finalityLagSec * 10) / 10,
    peerCount,
    inboundPeers: Number.isFinite(Number(nodeInfo?.network?.peer_count_inbound)) ? Number(nodeInfo.network.peer_count_inbound) : null,
    outboundPeers: Number.isFinite(Number(nodeInfo?.network?.peer_count_outbound)) ? Number(nodeInfo.network.peer_count_outbound) : null,
    version: nodeInfo?.code_version || null,
    mode: nodeInfo?.mode || null,
    txPoolSize: Number.isFinite(Number(nodeInfo?.tx_pool_size)) ? Number(nodeInfo.tx_pool_size) : null,
    responseMs: Number.isFinite(Number(responseMs)) ? Math.round(Number(responseMs)) : null,
  };
}
