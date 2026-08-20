// webmcp.js — WebMCP (webmachinelearning.github.io/webmcp) progressive enhancement.
// Exposes IOST Terminal's public, read-only tools to in-browser AI agents via
// navigator.modelContext.provideContext() (Chrome 143+ / WebMCP origin trial).
// Guarded: in browsers without the API this file is a harmless no-op.
// Execution stays on the REST API with scoped agent keys — these tools are
// read-only by design.
(function () {
  'use strict';
  var ctx = (typeof navigator !== 'undefined' && navigator.modelContext) ? navigator.modelContext : null;
  if (!ctx || typeof ctx.provideContext !== 'function') return;

  function json(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function textTool(data) {
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }

  ctx.provideContext({
    name: 'IOST Terminal',
    description: 'AI real-time trading platform for crypto and equities: live market data, AI trade scores (0-100), risk analysis, IOST on-chain dashboard, news sentiment and paper trading. Read-only tools — trades require a scoped API key via the REST API.',
    tools: [
      {
        name: 'getMarketSnapshot',
        description: 'Live platform snapshot: top AI trade scores, market mood, IOST mainnet state, autopilot status.',
        inputSchema: { type: 'object', properties: {} },
        execute: function () { return json('/api/ui-state').then(function (s) { return textTool({ ts: s.ts, market: s.market && { bullish: s.market.bullish, neutral: s.market.neutral, bearish: s.market.bearish }, onchain: s.onchain && s.onchain.chain && { tps: s.onchain.chain.tps, headBlock: s.onchain.chain.headBlock }, autopilot: s.autopilot && { enabled: s.autopilot.enabled, requireApproval: s.autopilot.config && s.autopilot.config.requireApproval }, topScores: (s.scores || []).slice(0, 10).map(function (x) { return { symbol: x.symbol, score: x.composite, grade: x.grade }; }) }); }); },
      },
      {
        name: 'getAssetScores',
        description: '0-100 AI trade scores for every watchlist asset with subscore breakdown.',
        inputSchema: { type: 'object', properties: {} },
        execute: function () { return json('/api/scores').then(function (d) { return textTool(d); }); },
      },
      {
        name: 'analyzeSymbol',
        description: 'Full AI analysis for one symbol (score, subscores, indicators, signals, price).',
        inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'e.g. IOST, BTC, ETH, SOL, AAPL, NVDA' } }, required: ['symbol'] },
        execute: function (args) { return json('/api/analyze/' + encodeURIComponent(String(args.symbol || '').toUpperCase())).then(textTool); },
      },
      {
        name: 'getNewsSentiment',
        description: 'Latest market headlines with bullish/bearish/neutral classification.',
        inputSchema: { type: 'object', properties: {} },
        execute: function () { return json('/api/news').then(textTool); },
      },
      {
        name: 'getChainStatus',
        description: 'IOST mainnet dashboard: TPS, head block, peers, large transfers.',
        inputSchema: { type: 'object', properties: {} },
        execute: function () { return json('/api/onchain').then(textTool); },
      },
      {
        name: 'getPlatformHelp',
        description: 'What IOST Terminal is and how an agent can connect (endpoints, auth, skills).',
        inputSchema: { type: 'object', properties: {} },
        execute: function () {
          return fetch('/llms.txt').then(function (r) { return r.text(); }).then(function (t) { return { type: 'text', text: t }; });
        },
      },
    ],
  });
})();
