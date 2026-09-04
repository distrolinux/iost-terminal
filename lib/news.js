// lib/news.js — News + Sentiment Engine (RSS, key-free, lexicon classification)
import { WATCHLIST } from './market.js';
import { inspectExternalText } from './agent-data-trust.js';

const FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const BULL = new Set([
  'surge', 'rall', 'gain', 'gains', 'bull', 'breakout', 'record', 'launch', 'launches',
  'partnership', 'upgrade', 'adopt', 'adoption', 'wins', 'beat', 'growth', 'pump', 'moon',
  'bullish', 'buy', 'buying', 'positive', 'support', 'airdrop', 'listing', 'milestone',
  'soar', 'skyrocket', 'climb', 'jump', 'spike', 'inflow', 'inflows', 'accumulate', 'approve',
  'approval', 'etf', 'institutional', 'mainnet', 'integration', 'billion', 'all-time', 'ath',
]);
const BEAR = new Set([
  'crash', 'drop', 'drops', 'plunge', 'hack', 'hacked', 'exploit', 'loss', 'loses', 'bear',
  'dump', 'sell', 'selling', 'ban', 'banned', 'lawsuit', 'sec', 'penalty', 'rug', 'attack',
  'breach', 'down', 'fall', 'falls', 'risk', 'warning', 'negative', 'delist', 'liquidation',
  'outflow', 'outflows', 'dip', 'slump', 'tumble', 'slide', 'weak', 'fear', 'panic',
  'investigation', 'fraud', 'collapse', 'bankrupt', 'layoff', 'downgrade', 'reject',
]);
const NEUTRALIZERS = new Set(['not', 'no', 'without', 'denies', 'unlikely']);

const ASSET_KEYWORDS = {
  IOST: ['iost'], BTC: ['bitcoin', 'btc'], ETH: ['ethereum', ' ether'], SOL: ['solana'],
  XRP: ['xrp', 'ripple'], DOGE: ['dogecoin'], ADA: ['cardano'], AVAX: ['avalanche'],
  LINK: ['chainlink'], DOT: ['polkadot'], SUI: ['sui'], ARB: ['arbitrum'], OP: ['optimism'],
  TON: ['ton'], NEAR: ['near'], LTC: ['litecoin'],
  AAPL: ['apple'], MSFT: ['microsoft'], NVDA: ['nvidia'], TSLA: ['tesla'], AMZN: ['amazon'],
  GOOGL: ['google', 'alphabet'], META: ['meta', 'facebook'], SPY: ['s&p 500', 'sp500'], QQQ: ['nasdaq'],
};
const ALL_CRYPTO = WATCHLIST.crypto;

const cache = { ts: 0, val: null };
const TTL = 5 * 60_000;

function classify(title) {
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  let score = 0;
  for (let i = 0; i < words.length; i++) {
    if (NEUTRALIZERS.has(words[i])) continue;
    if (BULL.has(words[i])) score += 1;
    else if (BEAR.has(words[i])) score -= 1;
  }
  const label = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
  return { label, score };
}

function parseRSS(xml, source) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || '';
    const date = (block.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/) || [])[1] || '';
    if (!title) continue;
    const clean = title.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const dataTrust = inspectExternalText({ text: clean, source, url: link, observedAt: date ? Date.parse(date) : Date.now() });
    const { label, score } = dataTrust.quarantined ? { label: 'neutral', score: 0 } : classify(clean);
    const assets = Object.entries(ASSET_KEYWORDS)
      .filter(([, kws]) => kws.some(k => clean.toLowerCase().includes(k)))
      .map(([sym]) => sym)
      .filter(sym => ALL_CRYPTO.includes(sym) || WATCHLIST.stocks.includes(sym));
    items.push({
      // Never pass instruction-like external text to an agent. Preserve only
      // its provenance hash and reason codes for owner review.
      title: dataTrust.quarantined ? 'External content quarantined by Data Trust Firewall' : clean,
      source, url: dataTrust.sourceAuthorized ? link : '', ts: date ? Date.parse(date) : Date.now(),
      sentiment: label, score, assets: dataTrust.quarantined ? [] : assets,
      dataTrust,
    });
  }
  return items;
}

async function fetchFeed(feed) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(feed.url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (IOST-Terminal/1.0)' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml, feed.name);
  } catch { return []; } finally { clearTimeout(t); }
}

export async function getNews(force = false) {
  if (cache.val && Date.now() - cache.ts < TTL && !force) return cache.val;
  const feeds = await Promise.all(FEEDS.map(fetchFeed));
  const items = feeds.flat().sort((a, b) => b.ts - a.ts).slice(0, 120);

  const byAsset = {};
  for (const sym of [...WATCHLIST.crypto, ...WATCHLIST.stocks]) {
    const hits = items.filter(i => i.assets.includes(sym));
    if (!hits.length) continue;
    const bulls = hits.filter(h => h.sentiment === 'bullish').length;
    const bears = hits.filter(h => h.sentiment === 'bearish').length;
    const neut = hits.length - bulls - bears;
    const avg = hits.reduce((a, h) => a + (h.score === 0 ? 0 : h.score / Math.abs(h.score) * (Math.abs(h.score) / 2)), 0) / hits.length;
    byAsset[sym] = {
      bullish: bulls, bearish: bears, neutral: neut, total: hits.length,
      avgScore: hits.length ? Math.round((avg + 0.5) * 100) : 50, // 0-100 (50 neutral)
      latest: hits.slice(0, 6),
    };
  }
  const market = {
    bullish: items.filter(i => i.sentiment === 'bullish').length,
    bearish: items.filter(i => i.sentiment === 'bearish').length,
    neutral: items.filter(i => i.sentiment === 'neutral').length,
    total: items.length,
  };
  cache.val = {
    items, byAsset, market, fetchedAt: Date.now(),
    trustBoundary: {
      externalContentAuthority: 'data-only',
      suspiciousContentHandling: 'quarantine-and-exclude',
      quarantined: items.filter((item) => item.dataTrust?.quarantined).length,
      provenanceHashed: true,
    },
  };
  cache.ts = Date.now();
  return cache.val;
}

export function scoreAssetSentiment(n) {
  if (!n || !Number.isFinite(Number(n.total)) || Number(n.total) <= 0) {
    return { score: 50, label: 'neutral', count: 0, bullish: 0, bearish: 0 };
  }
  const avgScore = Number.isFinite(Number(n.avgScore)) ? Number(n.avgScore) : 50;
  const bullish = Number.isFinite(Number(n.bullish)) ? Number(n.bullish) : 0;
  const bearish = Number.isFinite(Number(n.bearish)) ? Number(n.bearish) : 0;
  // avgScore is already centered at 50. Preserve that neutral midpoint instead of
  // adding it as a positive offset, which previously made neutral coverage score 60/bullish.
  const score = Math.max(0, Math.min(100, Math.round(50 + (avgScore - 50) * 0.2 + (bullish - bearish) * 6)));
  return {
    score,
    label: score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral',
    count: Number(n.total), bullish, bearish,
  };
}

export function getAssetSentiment(symbol) {
  return scoreAssetSentiment(cache.val?.byAsset?.[symbol]);
}
