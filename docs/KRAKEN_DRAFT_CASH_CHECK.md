# BTC/USD draft cash comparison

Owner-session-only POST /api/exchange-connections/account-review accepts the same
strict draft fields as order-review, restricted to BTC buy-limit USD drafts.
It queries safe credential permissions, Balance, BalanceEx and TradeVolume.
No order fields are transmitted to Kraken; only the fixed fee pair and nonces.

The server recomputes draft notional, then rounds an estimated fee upward at
8 decimals using the higher observed maker/taker rate. It compares with balance
minus used credit minus trade holds, excluding offered credit. Raw balances stay
in request memory, never in the response or persistence. Missing or unsupported
evidence is unavailable. Unknown is never zero. Platform fee is $0.

This is NOT full affordability verification: margin obligations, fee currency,
final fill fees, eligibility, venue system status, market rules and full risk are
not established. No funds reserved. Result always remains not-authorized.
Evidence expires 30 seconds after calculation starts; edits invalidate the UI.
The existing rate limit, owner single-flight and credential replacement discard
apply. No new MCP tools or authority. Tests use only synthetic scratch stores.

Official references: https://docs.kraken.com/api-reference/account-data/get-extended-balance
and https://docs.kraken.com/api-reference/account-data/get-trade-volume
Real-account read-only acceptance and complete live lifecycle remain outstanding.
