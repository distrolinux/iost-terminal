import { createHash, createHmac } from 'node:crypto';
import { assessKrakenFunding } from './kraken-funding-evidence.js';
import { assessKrakenFees } from './kraken-fee-evidence.js';

const READ = ['query-funds', 'query-open-trades', 'query-closed-trades', 'query-ledger'];
const TRADE = ['modify-trades', 'close-trades'];
// Unknown permissions fail closed, including newly introduced funding powers.
export function assessKrakenPermissions(info) {
  if (!Array.isArray(info?.permissions) || !info.permissions.length || info.permissions.some(p => typeof p !== 'string'))
    return { permissionStatus: 'unverified', profile: 'unknown', unexpectedPermissionCount: 0 };
  const permissions = [...new Set(info.permissions)];
  const unexpected = permissions.filter(p => !READ.includes(p) && !TRADE.includes(p));
  return {
    permissionStatus: unexpected.length ? 'restricted-permissions-required' : 'observed-allowed-permissions',
    profile: unexpected.length ? 'unsupported' : permissions.some(p => TRADE.includes(p)) ? 'trade-capable' : 'read-only',
    unexpectedPermissionCount: unexpected.length,
  };
}

export async function verifyKrakenConnection({ apiKey, apiSecret }, { fetchFn = fetch, now = Date.now, requireReadOnly = false, includeFundingEvidence = false, includeFeeEvidence = false } = {}) {
  const result = { checkedAt: now(), accountHealth: 'unverified', permissionStatus: 'unverified', profile: 'unknown', unexpectedPermissionCount: 0, executionAuthorized: false };
  if (typeof apiKey !== 'string' || !apiKey || typeof apiSecret !== 'string' || !apiSecret)
    return { ...result, reasonCode: 'credentials-unavailable' };
  const signal = AbortSignal.timeout(10_000);
  let nonce = BigInt(now()) * 1000n;
  const call = async method => {
    const path = `/0/private/${method}`;
    const n = String(++nonce);
    const body = new URLSearchParams({ nonce: n, ...(method === 'TradeVolume' ? { pair: 'XXBTZUSD' } : {}) }).toString();
    const digest = createHash('sha256').update(n + body).digest();
    const signature = createHmac('sha512', Buffer.from(apiSecret, 'base64')).update(Buffer.concat([Buffer.from(path), digest])).digest('base64');
    const response = await fetchFn(`https://api.kraken.com${path}`, { method: 'POST', redirect: 'error', signal, headers: { 'API-Key': apiKey, 'API-Sign': signature, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error('provider-rejected');
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 1048576) throw Error('provider-response-too-large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.error) || data.error.length || !data.result || typeof data.result !== 'object') throw new Error('provider-rejected');
    return data.result;
  };
  try {
    const info = await call('GetApiKeyInfo');
    Object.assign(result, assessKrakenPermissions(info));
    if (result.permissionStatus !== 'observed-allowed-permissions') return { ...result, reasonCode: 'permission-review-required' };
    if (requireReadOnly && result.profile !== 'read-only') return { ...result, reasonCode: 'read-only-key-required' };
    if (!info.permissions.includes('query-funds')) return { ...result, reasonCode: 'query-funds-required' };
    const balances = await call('Balance');
    if (Array.isArray(balances) || Object.values(balances).some(v => typeof v !== 'string' || !Number.isFinite(Number(v)))) throw new Error('invalid-balance');
    if (includeFundingEvidence === true) {
      try { result.fundingEvidence = assessKrakenFunding(await call('BalanceEx')); }
      catch { result.fundingEvidence = assessKrakenFunding(null); }
    }
    if (includeFeeEvidence === true) {
      try { result.feeEvidence = assessKrakenFees(await call('TradeVolume')); }
      catch { result.feeEvidence = assessKrakenFees(null); }
    }
    return { ...result, accountHealth: 'reachable', reasonCode: 'connection-observed-not-authorized' };
  } catch {
    // Provider errors and payloads can contain keys, account identifiers or balances.
    return { ...result, reasonCode: 'verification-unavailable' };
  }
}
