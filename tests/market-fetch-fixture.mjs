// Deterministic market response for the spawned MCP integration server. This
// preload affects only that child test process and keeps execution-preflight
// checks independent of public network availability.
const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.startsWith('https://www.okx.com/api/v5/market/ticker?instId=IOST-USDT')) {
    return new Response(JSON.stringify({
      code: '0', data: [{
        last: '10', askPx: '10.01', bidPx: '9.99', open24h: '10',
        high24h: '10.2', low24h: '9.8', volCcy24h: '1000',
        volCcyQuote24h: '10000', ts: String(Date.now()),
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/AAPL')) {
    return new Response(JSON.stringify({
      chart: {
        result: [{
          timestamp: [1_788_000_000, 1_788_086_400],
          indicators: { quote: [{
            open: [9.9, 10], high: [10.1, 10.2], low: [9.8, 9.9],
            close: [10, 10], volume: [1_000, 1_000],
          }] },
        }],
        error: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return nativeFetch(input, init);
};
