# Verified Execution Receipts v1

Verified Execution Receipts are the private paper-execution truth layer for
IOST Terminal. Every paper open that reaches the execution rail records either
an accepted, rejected or reversed result. Paper closes record their
server-observed or last-server-observed exit authority.

## Evidence captured

Each receipt contains:

- action, symbol, side, size, requested entry and notional;
- sanitized reasoning summary and confidence;
- server quote source, observation age, bid/ask spread, multi-venue quorum,
  exclusions, selected route and entry deviation;
- simulated fill price, server bid/ask authority, requested slippage ceiling,
  realized slippage, price improvement, zero-fee paper model and close P&L;
- paper scope, wallet/Pact gate and mission-gate results as booleans;
- the portfolio-risk decision, bounded policy, exposure/concentration,
  drawdown, daily-loss, stop-risk, volatility source/regime/dynamic cap, maximum
  new portfolio-order capacity, limiting factor and per-check results;
- an opaque execution-intent reference and retry-protection flag;
- policy decision and bounded reason code;
- authorization, broker, settlement and total latency;
- per-account sequence, previous hash, payload hash and receipt hash.

The UI shows the latest receipts in the authenticated Journal. Agents can read
the same private evidence through `paper_execution_receipts`; browser clients
use `GET /api/execution-receipts?limit=1..200`.

## Integrity and privacy

Receipts are appended to `data/execution-receipts.jsonl` with mode `0600`.
Every account has an independent SHA-256 chain. A payload, ordering or hash
change invalidates that account's chain and the read surface returns no
receipts. The store persists only opaque hashes for account, mission and paper
position correlation. Raw account, wallet, Pact, mission, position and
reservation identifiers are excluded, as are credentials and secrets.
Receipts written before portfolio-risk evidence was introduced remain
verifiable; new receipts bind the sanitized risk object into the payload hash.

Reasoning summaries are length-bounded and redact common API-key, access-token,
secret, password and bearer-token shapes. Receipts are tamper-evident local
evidence, not a public-chain attestation or a claim of external execution.

## Honest paper-fill semantics

The client entry is a requested reference, never fill authority. Crypto paper
opens require at least two fresh consensus-approved quotes during preflight.
Longs route to the lowest trusted ask and shorts to the highest trusted bid.
The same routed quote determines cash, wallet, Pact and mission
authorization. Spread above 100 basis points, stale quotes, and adverse
slippage above the caller's bounded `maxSlippageBps` fail before reservations
or broker work. Receipts label accepted opens `server-top-of-book-ask` or
`server-top-of-book-bid`, record the routed venue, and report slippage or price
improvement.

A close ignores any client exit price and records `server-market` or
`server-last-observed`.

No live order, token action or public-chain action is part of this feature.

## Verification

- `node tests/verified-execution-receipts-check.mjs`
- `node tests/mcp-http-integration-check.mjs`
- `npm test`
