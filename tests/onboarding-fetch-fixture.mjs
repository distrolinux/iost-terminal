import './market-fetch-fixture.mjs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input?.url || input);
  if (url === 'https://api.kraken.com/0/private/TradeVolume') return new Response(JSON.stringify({ error: [], result: { volume: '98765.4321', fees: { XXBTZUSD: { fee: '0.40' } }, fees_maker: { XXBTZUSD: { fee: '0.25' } } } }));
  if (url === 'https://api.kraken.com/0/private/GetApiKeyInfo') return new Response(JSON.stringify({ error: [], result: { permissions: ['query-funds'] } }));
  if (url === 'https://api.kraken.com/0/private/Balance') return new Response(JSON.stringify({ error: [], result: { ZUSD: '12.34' } }));
  if (url === 'https://api.kraken.com/0/private/BalanceEx') return new Response(JSON.stringify({ error: [], result: { ZUSD: { balance: '12.34', credit: '0', credit_used: '0', hold_trade: '1' } } }));
  if (url.startsWith('https://api.kraken.com/0/private/')) throw Error('unexpected private endpoint');
  return nativeFetch(input, options);
};
