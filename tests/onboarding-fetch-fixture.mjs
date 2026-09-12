import './market-fetch-fixture.mjs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input?.url || input);
  if (url === 'https://api.kraken.com/0/public/SystemStatus') return new Response(JSON.stringify({ error: [], result: { status: 'online', timestamp: new Date().toISOString(), emergency: [], upcoming_maintenance: [] } }));
  if (url === 'https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD') return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: { wsname: 'XBT/USD', aclass_base: 'currency', aclass_quote: 'currency', lot_multiplier: 1, lot_decimals: 8, pair_decimals: 1, tick_size: '0.1', ordermin: '0.00005', costmin: '0.5', status: 'online' } } }));
  if (url === 'https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD') return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: { a: ['50001'], b: ['50000'] } } }));
  if (url === 'https://api.kraken.com/0/private/TradeVolume') return new Response(JSON.stringify({ error: [], result: { volume: '98765.4321', fees: { XXBTZUSD: { fee: '0.40' } }, fees_maker: { XXBTZUSD: { fee: '0.25' } } } }));
  if (url === 'https://api.kraken.com/0/private/GetApiKeyInfo') return new Response(JSON.stringify({ error: [], result: { permissions: ['query-funds'] } }));
  if (url === 'https://api.kraken.com/0/private/Balance') return new Response(JSON.stringify({ error: [], result: { ZUSD: '12.34' } }));
  if (url === 'https://api.kraken.com/0/private/BalanceEx') return new Response(JSON.stringify({ error: [], result: { ZUSD: { balance: '12.34', credit: '0', credit_used: '0', hold_trade: '1' } } }));
  if (url.startsWith('https://api.kraken.com/0/private/')) throw Error('unexpected private endpoint');
  return nativeFetch(input, options);
};
