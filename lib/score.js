// lib/score.js — AI Trade Score: 0-100 per asset with 6 subscores
// momentum | technical setup | volume | news sentiment | on-chain activity | risk
import { getAssetSentiment } from './news.js';
import { getOnChainActivity } from './onchain.js';
import { normalize } from './indicators.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function computeScores(analysis, sentimentOverride = null, onchainOverride = null) {
  const ind = analysis.indicators || {};
  const type = analysis.type;

  // ---- 1. Momentum (RSI + ROC + MACD hist) ----
  let momentum = 50;
  if (ind.rsi != null) {
    // RSI 25 -> 0, 50 -> 50, 72 -> 100
    momentum = clamp(((ind.rsi - 25) / 47) * 100);
    if (ind.macdHist != null) momentum = clamp(momentum * 0.7 + (ind.macdHist > 0 ? 60 + Math.min(40, Math.abs(ind.macdHist) * 5e6) : 40 - Math.min(40, Math.abs(ind.macdHist) * 5e6)) * 0.3);
  }
  const rocM = normalize(ind.roc15m ?? 0, -4, 4); // -4%..+4% over 14 bars
  momentum = clamp(momentum * 0.6 + rocM * 0.4);

  // ---- 2. Technical setup (MA stack + breakout + S/R) ----
  let tech = 50;
  const maState = ind.maState;
  const maScore = maState === 'golden' ? 95 : maState === 'death' ? 10 :
    maState === 'bullish' ? 72 : maState === 'bearish' ? 28 : 50;
  const bk = analysis.signals.find(s => s.label === 'Breakout' || s.label === 'Breakdown');
  const bkScore = bk ? (bk.direction === 'bullish' ? 90 : 12) : 50;
  let srScore = 50;
  if (ind.support != null && analysis.price / ind.support - 1 < 0.015) srScore = 75;
  if (ind.resistance != null && ind.resistance / analysis.price - 1 < 0.015) srScore = 25;
  tech = clamp(maScore * 0.4 + bkScore * 0.3 + srScore * 0.3);

  // ---- 3. Volume (z-score + whale activity) ----
  let vol = 50;
  const vz = ind.volZ ?? 0;
  vol = clamp(50 + vz * 18); // z=0 -> 50, z=2 -> 86, z=-1.5 -> 23
  if (analysis.whale?.bigTrades24h > 0) vol = clamp(vol + Math.min(12, analysis.whale.bigTrades24h * 3));
  if (analysis.change24hPct != null && Math.abs(analysis.change24hPct) > 0 && analysis.vol24hQuote > 0) {
    // healthy participation check
  }

  // ---- 4. News sentiment ----
  const news = sentimentOverride || getAssetSentiment(analysis.symbol);
  const newsScore = news?.score ?? 50;

  // ---- 5. On-chain activity ----
  let onchainScore = 50;
  if (type === 'crypto') {
    if (onchainOverride) onchainScore = onchainOverride.score;
    else {
      const oc = getOnChainActivity(analysis.symbol); // sync cache read; null for non-IOST
      if (oc) onchainScore = oc.score;
      else {
        // proxy from exchange activity: big trades + trade depth
        const big = analysis.whale?.bigTrades24h ?? 0;
        onchainScore = clamp(50 + big * 4);
      }
    }
  }

  // ---- 6. Risk (100 = LOWEST risk) ----
  let risk = 70;
  const atrPct = ind.atrPct ?? 2;
  const volScale = type === 'crypto' ? [1, 5] : [1, 6]; // ATR% bands
  const atrScore = clamp(100 - ((atrPct - volScale[0]) / (volScale[1] - volScale[0])) * 100);
  risk = atrScore * 0.6 + 40 * 0.4;
  if (ind.rsi != null && (ind.rsi > 78 || ind.rsi < 22)) risk = clamp(risk - 18);
  if (Math.abs(analysis.change24hPct || 0) > 12 && type === 'crypto') risk = clamp(risk - 12);
  if (ind.resistance != null && analysis.price / ind.resistance > 0.985) risk = clamp(risk - 5);

  // ---- Composite ----
  const composite = clamp(
    momentum * 0.20 + tech * 0.20 + vol * 0.20 + newsScore * 0.15 + onchainScore * 0.15 + risk * 0.10
  );

  const grade = composite >= 80 ? 'Strong buy' : composite >= 65 ? 'Buy' :
    composite >= 50 ? 'Neutral' : composite >= 35 ? 'Avoid' : 'Strong avoid';

  return {
    symbol: analysis.symbol, type, price: analysis.price, ts: analysis.ts,
    composite: Math.round(composite), grade,
    subscores: {
      momentum: Math.round(momentum),
      technical: Math.round(tech),
      volume: Math.round(vol),
      news: Math.round(newsScore),
      onchain: Math.round(onchainScore),
      risk: Math.round(risk),
    },
    weights: { momentum: 0.2, technical: 0.2, volume: 0.2, news: 0.15, onchain: 0.15, risk: 0.1 },
    components: {
      rsi: ind.rsi, roc15m: ind.roc15m, maState: ind.maState, volZ: ind.volZ,
      atrPct: ind.atrPct, support: ind.support, resistance: ind.resistance,
      whaleCount: analysis.whale?.bigTrades24h ?? 0,
      newsLabel: news.label, newsCount: news.count,
    },
  };
}
