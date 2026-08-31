# Execution Quality and Latency Engine

IOST Terminal scores every trusted crypto paper-execution venue on price,
latency and rolling reliability before selecting a route. The engine is
read-only during preflight and cannot place, reserve or approve an order.

## Price protection

The best trusted ask for a long or best trusted bid for a short is the anchor.
A different venue is eligible only when its price is no more than 10 basis
points worse. This prevents a fast venue from winning with a materially worse
fill. Price has 45% of the quality score, latency 35%, and reliability 20%.

## Latency and reliability

- Target quote latency: 500 ms.
- Maximum eligible quote latency: 2,500 ms.
- Minimum reliability after five observations: 90%.
- Three consecutive failures open the in-memory venue circuit breaker.
- The rolling window contains the latest 20 observations per venue.

Venue requests remain concurrent, so one slow source does not serialize the
others. Health history contains only sanitized timing and success/failure
observations and resets safely when the server restarts.

## Failover

The engine automatically selects the highest-scoring price-protected healthy
venue. Evidence reports whether failover occurred and whether it was caused by
a circuit breaker, reliability SLO, maximum latency, or the balanced quality
score. If no safe route remains, preflight denies with
`execution-quality-unavailable` before any reservation, receipt, intent
execution or paper trade.

The complete decision is bound into the preflight fingerprint and copied into
tamper-evident execution receipts. The Journal shows the selected score, tier,
reliability and failover reason.

## Safety boundary

This release remains paper-only. It adds no live tool, live scope, credential,
withdrawal, token, swap or public-chain path. Quality decisions report
`liveScopeUsed=false`, `publicChainUsed=false`, and no attempted execution.

## Verification

```bash
node tests/execution-quality-engine-check.mjs
node tests/multi-venue-quote-integrity-check.mjs
node tests/agent-trade-preflight-check.mjs
node tests/verified-execution-receipts-check.mjs
node tests/mcp-http-integration-check.mjs
```
