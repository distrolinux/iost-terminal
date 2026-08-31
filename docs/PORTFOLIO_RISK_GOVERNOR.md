# Server-Authoritative Portfolio Risk Governor

The Portfolio Risk Governor is a paper-only, fail-closed safety layer evaluated
by the server during every paper-open preflight. Agents cannot override its
inputs with claimed portfolio values. The decision is recomputed immediately
before any reservation or simulated fill and is bound into the HMAC preflight
fingerprint and tamper-evident execution receipt.

## Default policy

- new order: at most 10% of current equity;
- gross exposure after the order: at most 80% of equity;
- one-symbol exposure: at most 25% of equity;
- correlated sleeve exposure: at most 50% of equity;
- peak-to-current drawdown breaker: 10%;
- UTC-day realized-loss breaker: 3% of initial paper cash;
- protective-stop risk: at most 1% of current equity;
- open positions after the order: at most 10;
- new order during calm volatility: at most 10% of equity;
- new order during normal volatility: at most 7.5% of equity; and
- new order during storm, stale or unavailable volatility: at most 5% of equity.

Agent and MCP opens require a valid protective stop. Human-session paper opens
retain their optional-stop workflow, but every supplied stop and every other
portfolio limit is still checked. The volatility rule prefers a recent cached
GARCH state. When it is unavailable, the Volatility Sentinel calculates a
robust 24-hour range proxy from the same trusted venue quotes already collected
for execution, adding no serial market request. Stale or missing evidence
receives the conservative 5% cap. All structural limits still apply.

Every decision also reports the maximum new portfolio order in dollars and as a
percentage of equity. That capacity is the minimum remaining headroom across
cash, order, volatility, gross, symbol, correlated sleeve, stop risk, position
count, drawdown and daily-loss rails, with its limiting factor named.

## Evidence and privacy

The preflight returns a machine-readable allow/deny decision, bounded policy,
sanitized metrics and individual check results. It never returns account,
wallet, Pact, owner, position or reservation identifiers. New execution
receipts include the sanitized risk evidence in their SHA-256 payload chain;
older receipts remain valid without that optional field.

The governor never creates a reservation, receipt, position, live order, token
action or public-chain transaction. A denied or changed decision fails before
paper broker work. Closing an existing paper position remains risk-reducing and
does not require a new portfolio-open decision.

## Verification

```bash
node tests/portfolio-risk-governor-check.mjs
node tests/volatility-sentinel-check.mjs
node tests/agent-trade-preflight-check.mjs
node tests/verified-execution-receipts-check.mjs
node tests/mcp-http-integration-check.mjs
npm test
```
