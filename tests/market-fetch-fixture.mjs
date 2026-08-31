// Deterministic market response for the spawned MCP integration server. This
// preload affects only that child test process and keeps execution-preflight
// checks independent of public network availability.
const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.startsWith('https://www.okx.com/api/v5/market/ticker?instId=IOST-USDT')) {
    return new Response(JSON.stringify({
      code: '0', data: [{
        last: '10', askPx: '10.02', bidPx: '9.98', open24h: '10',
        high24h: '10.2', low24h: '9.8', volCcy24h: '1000',
        volCcyQuote24h: '10000', ts: String(Date.now()),
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=IOST-USDT')) {
    return new Response(JSON.stringify({
      code: '200000', data: { price: '10', bestAsk: '10.01', bestBid: '9.97' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://api.kucoin.com/api/v1/market/stats?symbol=IOST-USDT')) {
    return new Response(JSON.stringify({
      code: '200000', data: { open: '10', high: '10.2', low: '9.8', volValue: '10000' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=IOST_USDT')) {
    return new Response(JSON.stringify([{
      last: '10', lowest_ask: '10.03', highest_bid: '9.99',
      change_percentage: '0', high_24h: '10.2', low_24h: '9.8',
      base_volume: '1000', quote_volume: '10000',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
