# Verified Execution Receipts v1

Verified Execution Receipts are the private paper-execution truth layer for
IOST Terminal. Every paper open that reaches the execution rail records either
an accepted, rejected or reversed result. Paper closes record their
server-observed or last-server-observed exit authority.

## Evidence captured

Each receipt contains:

- action, symbol, side, size, requested entry and notional;
- sanitized reasoning summary and confidence;
- cached server quote source, observation age, bid/ask spread and entry
  deviation when an observation exists;
- simulated fill price, fill authority, zero-fee paper model and close P&L;
- paper scope, wallet/Pact gate and mission-gate results as booleans;
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

Reasoning summaries are length-bounded and redact common API-key, access-token,
secret, password and bearer-token shapes. Receipts are tamper-evident local
evidence, not a public-chain attestation or a claim of external execution.

## Honest paper-fill semantics

An explicit paper entry remains a client-supplied simulated fill and is labeled
`client-supplied-paper-entry`. A close ignores any client exit price and records
`server-market` or `server-last-observed`. Cached quote evidence never triggers
an extra network request in the execution path: if no cached observation exists,
the receipt says so instead of fabricating freshness or slippage.

No live order, token action or public-chain action is part of this feature.

## Verification

- `node tests/verified-execution-receipts-check.mjs`
- `node tests/mcp-http-integration-check.mjs`
- `npm test`
