// lib/marketdata.js — market-wide data layer: CoinGecko + Fear&Greed + CMC (optional key).
// Global metrics, top gainers/losers, per-symbol rank/market cap. Everything is
// cached with TTLs and fails soft (nulls, never throws) so the platform keeps
// working if a provider is down. CMC enrichment activates only when
// CMC_API_KEY is set in .env (free tier ~10k calls/mo → 15-min TTL keeps us
// under ~100/day).
const CG = 'https://api.coingecko.com/api/v3';
const FNG = 'https://api.alternative.me/fng/';
const CMC = 'https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest';
const cache = new Map();
const TTL = { global: 60_000, movers: 90_000, extras: 120_000, cmc: 900_000 };

async function jget(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'Accept': 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.val;
  return fn().then(v => { cache.set(key, { ts: Date.now(), val: v }); return v; });
}

/** Global crypto market metrics + Fear & Greed. Nulls when unavailable. */
export async function getGlobalMetrics() {
  const out = { totalMcapUsd: null, btcDominance: null, volume24hUsd: null, activeCoins: null, fearGreed: null, fearGreedLabel: null };
  await Promise.allSettled([
    cached('cg:global', TTL.global, async () => {
      const d = (await jget(`${CG}/global`)).data;
      out.totalMcapUsd = d.total_market_cap?.usd ?? null;
      out.btcDominance = d.market_cap_percentage?.btc ?? null;
      out.volume24hUsd = d.total_volume?.usd ?? null;
      out.activeCoins = d.active_cryptocurrencies ?? null;
    }),
    cached('fng', TTL.global, async () => {
      const d = (await jget(`${FNG}?limit=1`)).data?.[0];
      out.fearGreed = d?.value != null ? +d.value : null;
      out.fearGreedLabel = d?.value_classification ?? null;
    }),
  ]);
  return out;
}

/** CMC global metrics (optional key). Nulls when no key or provider down. */
export async function getCmcGlobal() {
  const key = process.env.CMC_API_KEY;
  if (!key) return { enabled: false, btcDominance: null, ethDominance: null, mcapUsd: null, volume24hUsd: null, lastUpdated: null };
  return cached('cmc:global', TTL.cmc, async () => {
    const d = (await jget(CMC, { headers: { 'X-CMC_PRO_API_KEY': key } })).data;
    const q = d?.quote?.USD ?? {};
    return {
      enabled: true,
      btcDominance: d?.btc_dominance ?? null,
      ethDominance: d?.eth_dominance ?? null,
      mcapUsd: q.total_market_cap ?? null,
      volume24hUsd: q.total_volume_24h ?? null,
      lastUpdated: d?.last_updated ?? null,
    };
  }).catch(() => ({ enabled: true, btcDominance: null, ethDominance: null, mcapUsd: null, volume24hUsd: null, lastUpdated: null }));
}

/** Top 5 gainers + top 5 losers (24h) from the top-80 by market cap. */
export async function getTopMovers() {
  return cached('cg:movers', TTL.movers, async () => {
    const list = await jget(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80&page=1&price_change_percentage=24h`);
    const mapped = list.map(c => ({
      symbol: String(c.symbol || '').toUpperCase(),
      name: c.name, price: c.current_price,
      change24hPct: c.price_change_percentage_24h,
      marketCap: c.market_cap, rank: c.market_cap_rank,
    }));
    const gainers = mapped.filter(m => m.change24hPct != null).sort((a, b) => b.change24hPct - a.change24hPct).slice(0, 5);
    const losers = mapped.filter(m => m.change24hPct != null).sort((a, b) => a.change24hPct - b.change24hPct).slice(0, 5);
    return { gainers, losers };
  });
}

/** Rank + market cap for a set of symbols (case-insensitive). */
export async function getMarketExtras(symbols = []) {
  const wanted = new Set(symbols.map(s => String(s).toUpperCase()));
  return cached('cg:extras', TTL.extras, async () => {
    const list = await jget(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`);
    const out = {};
    for (const c of list) {
      const sym = String(c.symbol || '').toUpperCase();
      if (wanted.has(sym)) {
        out[sym] = { rank: c.market_cap_rank ?? null, marketCap: c.market_cap ?? null, fdv: c.fully_diluted_valuation ?? null };
      }
    }
    return out;
  });
}
