# Multi-Venue Quote Integrity

IOST Terminal uses a stricter market-data path for crypto paper execution than
for ordinary market scanning. Before execution preflight can allow a trade, the
server concurrently observes OKX, KuCoin and Gate.io.

## Fail-closed rules

- At least two venues must provide fresh, structurally valid bid/ask quotes.
- Quotes older than 10 seconds are excluded.
- Markets with non-positive prices, a bid above the ask, or a local spread
  above 100 basis points are excluded.
- A venue midpoint more than 100 basis points from the cross-venue median is
  excluded as a consensus outlier.
- If fewer than two trusted venues remain, preflight denies with
  `quote-quorum` before any reservation, receipt, intent execution or trade.
- The routed venue must still pass the 100-basis-point spread ceiling and the
  caller's explicit adverse-slippage ceiling.

## Routing

After quorum, a long routes to the lowest ask among trusted venues and a short
routes to the highest bid. Equal prices prefer the lower-latency observation.
The selected venue and price are bound into the HMAC preflight fingerprint.
Execution recomputes the evidence and fails closed if the quorum, route, price,
account state or authorization changed.

Stocks retain the existing delayed single-source paper model and are explicitly
reported as not requiring multi-venue quorum.

## Evidence

Preflight and receipts report sanitized evidence: venue/trusted/excluded counts,
exclusion reasons, consensus price, trusted deviation, route venue and latency,
per-venue bid/ask/age/latency, and the simulated fill venue and slippage.

No API credential, wallet identifier, Pact identifier, live order or
public-chain action is part of quote selection.

## Verification

```bash
node tests/multi-venue-quote-integrity-check.mjs
node tests/mcp-http-integration-check.mjs
node tests/verified-execution-receipts-check.mjs
```
