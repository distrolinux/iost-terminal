// lib/assistant.js — AI Trade Assistant
// Local synthesis engine: answers "why is IOST moving?" from live data + rule-based reasoning.
// No LLM API key required. (Upgrade path: swap in an LLM call with the same context bundle.)
import { getTicker, WATCHLIST } from './market.js';
import { analyzeSymbol } from './scanner.js';
import { computeScores } from './score.js';
import { getNews } from './news.js';
import { getChainSnapshot } from './onchain.js';
import { getState } from './paper.js';

const ALIASES = {
  iost: 'IOST', btc: 'BTC', bitcoin: 'BTC', eth: 'ETH', ethereum: 'ETH', sol: 'SOL', solana: 'SOL',
  xrp: 'XRP', ripple: 'XRP', doge: 'DOGE', dogecoin: 'DOGE', ada: 'ADA', cardano: 'ADA',
  avax: 'AVAX', avalanche: 'AVAX', link: 'LINK', chainlink: 'LINK', dot: 'DOT', polkadot: 'DOT',
  sui: 'SUI', arb: 'ARB', arbitrum: 'ARB', op: 'OP', optimism: 'OP', ton: 'TON', near: 'NEAR',
  ltc: 'LTC', litecoin: 'LTC', aapl: 'AAPL', apple: 'AAPL', msft: 'MSFT', microsoft: 'MSFT',
  nvda: 'NVDA', nvidia: 'NVDA', tsla: 'TSLA', tesla: 'TSLA', amzn: 'AMZN', amazon: 'AMZN',
  googl: 'GOOGL', google: 'GOOGL', meta: 'META', spy: 'SPY', qqq: 'QQQ',
};

function extractSymbols(text) {
  const found = new Set();
  const lower = text.toLowerCase();
  for (const [alias, sym] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(lower)) found.add(sym);
  }
  const m = text.match(/@([A-Za-z]{2,6})/);
  if (m && (WATCHLIST.crypto.includes(m[1].toUpperCase()) || WATCHLIST.stocks.includes(m[1].toUpperCase()))) {
    found.add(m[1].toUpperCase());
  }
  return [...found];
}

const fmt = (n, d = 4) => n == null ? '—' : (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : d > 0 ? Number(n).toPrecision(d) : Math.round(n).toLocaleString());

function sentimentWord(s) {
  return s.label === 'bullish' ? '🟢 bullish' : s.label === 'bearish' ? '🔴 bearish' : '⚪ neutral';
}

export async function answer(question) {
  const symbols = extractSymbols(question);
  const lower = question.toLowerCase();
  const wantsRisk = /risk|position size|stop loss|rr\b|reward/i.test(lower);

  try {
    if (symbols.length && !wantsRisk) {
      const sym = symbols[0];
      const [analysis, news] = await Promise.all([analyzeSymbol(sym, { force: true }), getNews()]);
      const scores = computeScores(analysis);
      const oc = sym === 'IOST' ? await getChainSnapshot() : null;
      const assetNews = news.byAsset[sym];
      const reasons = [];

      if (analysis.change24hPct != null && Math.abs(analysis.change24hPct) >= 0.5) {
        reasons.push(`price is ${analysis.change24hPct > 0 ? 'up' : 'down'} **${Math.abs(analysis.change24hPct).toFixed(2)}%** in 24h (now ${fmt(analysis.price)})`);
      }
      if (assetNews && assetNews.total > 0) {
        const top = assetNews.latest[0];
        reasons.push(`top headline: "${top.title}" — ${sentimentWord(top)}${assetNews.bullish + assetNews.bearish ? ` (${assetNews.bullish} bull / ${assetNews.bearish} bear)` : ''}`);
      } else {
        reasons.push('no direct headlines in the last feed cycle — move is not news-driven');
      }
      const ind = analysis.indicators;
      if (ind.volZ >= 1.2) reasons.push(`volume is **${ind.volZ.toFixed(1)}σ** above its 20-bar average (unusual volume)`);
      else if (ind.volZ <= -1) reasons.push(`volume is drying up (${ind.volZ.toFixed(1)}σ below average)`);
      if (analysis.whale.bigTrades24h > 0) reasons.push(`whale activity: **${analysis.whale.bigTrades24h}** large trades (≥ $25k or 12× median size), largest ${fmt(analysis.whale.largestUsd, 0)} USDT`);
      if (ind.rsi != null) reasons.push(`RSI(14) ${ind.rsi.toFixed(1)} (${ind.rsi >= 70 ? 'overbought' : ind.rsi <= 30 ? 'oversold' : 'mid-range'})`);
      if (ind.maState) reasons.push(`EMA trend is ${ind.maState === 'golden' ? 'in a fresh golden cross' : ind.maState === 'death' ? 'in a fresh death cross' : ind.maState}`);
      const bk = analysis.signals.find(s => s.label === 'Breakout' || s.label === 'Breakdown');
      if (bk) reasons.push(`${bk.type} beyond ${fmt(bk.level)}`);
      if (ind.atrPct != null) reasons.push(`volatility (ATR) at ${ind.atrPct.toFixed(2)}%/bar`);
      if (oc?.live) {
        reasons.push(`on-chain: **${oc.chain.tps} TPS**, ${oc.chain.activeAddresses} active addresses (last ${oc.series.length} blocks)${oc.largeTxs.length ? `, ${oc.largeTxs.length} large transfers ≥ ${fmt(oc.largeTxs[0]?.usd ?? 0, 0)} USDT` : ''}`);
      }

      const s = scores.subscores;
      const summary = `${sym} moves are driven by ${reasons[0] ?? 'steady flow'}; ${reasons.length > 1 ? reasons.slice(1, 4).join('; ') + '.' : ''}`;

      return {
        ok: true, symbol: sym, question,
        summary: `${summary} Overall AI trade score: **${scores.composite}/100 (${scores.grade})** — momentum ${s.momentum}, technical ${s.technical}, volume ${s.volume}, news ${s.news}, on-chain ${s.onchain}, risk ${s.risk}.`,
        reasons, scores, price: analysis.price, ts: Date.now(),
        disclaimer: 'Synthesis engine output — not financial advice. Paper trade first.',
      };
    }

    if (wantsRisk && symbols.length) {
      return {
        ok: true, symbol: symbols[0], question,
        summary: 'I can compute this for you — open the **Risk Engine** tab and enter: account size, max risk %, entry, stop (optional target). It returns position size, $ risk, R:R, potential P/L and portfolio exposure instantly.',
        reasons: ['Risk math is deterministic — use the Risk Engine tab for exact numbers with your real parameters.'],
        disclaimer: 'Not financial advice.',
      };
    }

    // market-wide answer
    const news = await getNews();
    const m = news.market;
    const mood = m.bullish > m.bearish * 1.5 ? '🟢 market news skews bullish' : m.bearish > m.bullish * 1.5 ? '🔴 market news skews bearish' : '⚪ mixed market news';
    const topNews = news.items.slice(0, 3).map(i => `- "${i.title}" (${i.source}, ${sentimentWord(i)})`).join('\n');
    return {
      ok: true, symbol: null, question,
      summary: `${mood} — ${m.bullish} bullish / ${m.neutral} neutral / ${m.bearish} bearish headlines in the feed. Top stories:\n${topNews}\n\nTip: name a coin/stock (e.g. "why is IOST moving today?") for an asset-level breakdown.`,
      reasons: [], ts: Date.now(),
      disclaimer: 'Synthesis engine output — not financial advice.',
    };
  } catch (e) {
    return { ok: false, question, error: `Assistant data fetch failed: ${e.message}`, summary: 'Live data temporarily unavailable — retry in a few seconds.' };
  }
}

export function assistantStatus() {
  const st = getState();
  return {
    engine: 'Local synthesis (rule-based over live data)',
    upgrade: 'Optional: wire an LLM (e.g. DeepSeek/OpenAI) using the same context bundle.',
    openPositions: st.positions.length,
  };
}
