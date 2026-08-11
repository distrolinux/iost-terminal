// lib/portfolio.js — Portfolio AI: whole-portfolio analysis, not per-coin
export function analyzePortfolio({ cash = 0, positions = [], accountSize = 0, scores = {}, sentiment = {} } = {}) {
  if (!positions.length) {
    return {
      ok: true, empty: true, equity: cash, cash, accountSize,
      message: 'No open positions. Open a trade to see portfolio-level AI analysis.',
      suggestions: ['Start with the AI Trade Score tab to find a setup rated 65+.', 'Never risk more than 1-2% of account per trade.'],
    };
  }

  let unrealized = 0, totalNotional = 0;
  const bySymbol = {};
  for (const p of positions) {
    const u = (p.lastPrice - p.entry) * p.size * (p.side === 'long' ? 1 : -1);
    unrealized += u;
    totalNotional += p.notional;
    bySymbol[p.symbol] = (bySymbol[p.symbol] || { notional: 0, pnl: 0, side: p.side }) &&
      { notional: (bySymbol[p.symbol]?.notional || 0) + p.notional, pnl: (bySymbol[p.symbol]?.pnl || 0) + u, side: p.side };
  }
  const equity = cash + unrealized;
  const cryptoN = positions.filter(p => p.type === 'crypto').length;
  const stockN = positions.filter(p => p.type === 'stock').length;
  const longN = positions.filter(p => p.side === 'long').length;
  const shortN = positions.length - longN;

  const holdings = Object.entries(bySymbol).map(([symbol, v]) => ({
    symbol, notional: Math.round(v.notional * 100) / 100,
    weightPct: totalNotional ? Math.round((v.notional / totalNotional) * 1000) / 10 : 0,
    unrealizedPnl: Math.round(v.pnl * 100) / 100, side: v.side,
    score: scores[symbol]?.composite ?? null,
    news: sentiment[symbol]?.label ?? null,
  })).sort((a, b) => b.weightPct - a.weightPct);

  const topHolding = holdings[0];
  const concentrationRisk = topHolding.weightPct > 30 ? 'high' : topHolding.weightPct > 15 ? 'medium' : 'low';

  const scored = holdings.filter(h => h.score != null);
  const avgScore = scored.length ? Math.round(scored.reduce((a, h) => a + h.score, 0) / scored.length) : null;
  const bullNews = holdings.filter(h => h.news === 'bullish').length;
  const bearNews = holdings.filter(h => h.news === 'bearish').length;

  const exposurePct = accountSize ? (totalNotional / accountSize) * 100 : 0;
  const suggestions = [];
  if (exposurePct > 80) suggestions.push('Gross exposure is high — consider trimming size or adding hedges.');
  if (concentrationRisk === 'high') suggestions.push(`Position in ${topHolding.symbol} is ${topHolding.weightPct}% of notional — concentrate risk.`);
  if (stockN === 0 && cryptoN > 2) suggestions.push('Portfolio is 100% crypto — consider a stock sleeve for diversification.');
  if (shortN === 0 && longN > 0) suggestions.push('No shorts open — if bearish signals appear, portfolio has no downside hedge.');
  if (bearNews > 0) suggestions.push(`${bearNews} holding(s) with bearish news sentiment — review stops on those.`);
  if (avgScore != null && avgScore < 55) suggestions.push(`Average AI trade score is ${avgScore} — portfolio skews weak; consider rotating to 65+ setups.`);
  if (!suggestions.length) suggestions.push('Portfolio looks balanced. Maintain 1-2% per-trade risk and keep reviewing scores.');

  return {
    ok: true, empty: false,
    equity: Math.round(equity * 100) / 100,
    cash: Math.round(cash * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    totalNotional: Math.round(totalNotional * 100) / 100,
    exposurePct: Math.round(exposurePct * 1000) / 10,
    composition: { crypto: cryptoN, stocks: stockN, longs: longN, shorts: shortN },
    avgScore, bullishNews: bullNews, bearishNews: bearNews,
    concentrationRisk, topHolding: topHolding?.symbol ?? null,
    holdings, suggestions,
  };
}
