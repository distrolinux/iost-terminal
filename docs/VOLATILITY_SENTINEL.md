# Volatility Sentinel and Dynamic Risk Budget

The Volatility Sentinel is a pure, paper-only execution-safety component. It
selects the best fresh volatility evidence already available to the server and
converts it into a maximum new-order percentage. It performs no execution,
reservation, receipt, live-order, token or public-chain action.

## Evidence priority

1. A cached GARCH one-day forecast no older than six hours.
2. A Parkinson 24-hour high/low range proxy calculated from the trusted venues
   already accepted by execution quote integrity.
3. Conservative unknown evidence when neither source is fresh.

The fallback adds no serial network request to preflight. Two or more valid
trusted-venue ranges are high-quality evidence; one is medium-quality evidence.
The response reports source, quality, age, venue count, daily and annualized
volatility, and regime without exposing private identifiers.

## Regimes and budgets

Crypto is calm below 2% daily range volatility, normal from 2% to below 5%, and
storm at 5% or above. Stocks are calm below 1%, normal from 1% to below 3%, and
storm at 3% or above.

- calm: maximum new order 10% of current equity;
- normal: 7.5%;
- storm: 5%;
- stale or unavailable: 5%.

The Portfolio Risk Governor intersects that dynamic cap with cash, gross,
symbol, correlated-sleeve and stop-risk headroom plus position-count, drawdown
and daily-loss breakers. It returns the maximum new portfolio order in USD and
percent, a headroom map and every limiting factor.

Volatility source, freshness class, regime, cap and risk capacity are bound into
the preflight HMAC and new SHA-256-chained receipts. The continuously advancing
age timer is displayed but not fingerprinted; the underlying quote timestamp
and freshness expiry remain bound by the market evidence.

## Verification

```bash
node tests/volatility-sentinel-check.mjs
node tests/multi-venue-quote-integrity-check.mjs
node tests/portfolio-risk-governor-check.mjs
node tests/agent-trade-preflight-check.mjs
node tests/verified-execution-receipts-check.mjs
node tests/mcp-http-integration-check.mjs
npm test
```
