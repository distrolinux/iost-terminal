# Spot settlement evidence — HOLD

`previewSpotLedgerEvidence` is an offline, pure arithmetic preview. It accepts an expected reference and exact base/quote asset identifiers plus exactly two ordinary spot trade ledger legs. It rejects missing/duplicate legs, mismatched references/assets/directions/amounts, unsupported subtypes, margin entries and malformed decimals. Fees stay in their reported asset; net change is amount minus fee. Arithmetic uses fixed-point integers, never floating point.

Kraken distinguishes a trade-history fee estimate in quote currency from actual ledger fees. Each ledger entry's amount and fee are in that entry's asset:

- https://support.kraken.com/articles/360001169383-how-to-interpret-ledger-history-fields
- https://support.kraken.com/au/articles/115000302707-differences-between-ledger-and-trades-history
- https://docs.kraken.com/api-reference/account-data/get-ledgers-info

## Deliberately incomplete

Matching two supplied legs is not proof of authenticated, complete settlement. This helper cannot prove their origin, account/wallet ownership, fill-to-reference linkage, pagination completeness, reversals, or continuity of venue balances. Those require a separate authenticated acquisition and reconciliation layer. Never derive a ledger reference from an order ID or infer missing records. Third-asset fees (including KFEE), rebates and split legs are unsupported, not silently normalized.

Every result retains `settlementVerified: false`, `releaseAllowed: false`, and `executionAuthorized: false`. No endpoint, MCP tool, exchange request, accounting write, hold release or trading permission is added. It is not yet wired into the broker. Draft #104 remains HOLD pending authenticated settlement acquisition, replay-safe ledger posting and the other lifecycle acceptance requirements.

Verification uses synthetic buy/sell fixtures, base/quote fees, invalid records and immutable safety flags. Production is unchanged.
