# Kraken public draft market evidence

The signed-in owner's order draft workspace offers an explicit **Check Kraken market rules** button. The existing arithmetic-only button remains network-free with respect to exchanges. Both paths remain `not-authorized`; no orders, credentials, approvals or saved drafts are involved.

`POST /api/exchange-connections/market-review` requires an owner session, rejects agent/platform keys even alongside a session, uses the existing same-origin enforcement, shares a 20/minute review limiter, and returns private/no-store responses. Inputs use the same closed draft schema. Only the public pair symbol is sent upstream, not quantity, stop, limit price, fees or identity.

## Checked evidence

- USD currency pairs matched by exact Kraken display pair; explicit BTC → XBT legacy alias only. Unsupported or ambiguous pairs cannot pass.
- Online pair status, minimum asset quantity, minimum notional, lot decimal precision and price tick/precision. Comparisons use fixed-point integers and unrounded products.
- Pair-matched positive bid/ask, non-crossed spread, retrieval time and 30-second display expiry. Any input change invalidates the displayed snapshot.
- Fixed HTTPS public AssetPairs/Ticker endpoints, GET only, redirects rejected, shared eight-second timeout, bounded 256 KiB responses and maximum four concurrent checks. Errors are sanitized; no stale-cache fallback.

## Deliberate limits

`public-checks-passed` is not a live preflight or exchange order-validation result. Account balances, regional availability, permissions, venue-wide system status and full risk rails are not checked. Non-online pairs are conservatively marked invalid even where limited order types might be accepted. Unknown fees stay unknown; entered fees remain assumptions. Stop orders are not armed or validated against venue rules.

Kraken ticker does not supply a source quote timestamp: source quote age is explicitly null/unknown. Local retrieval time must not be represented as market-source freshness. Display expiry does not guarantee a fill or authorize execution. Failed public checks and unavailable evidence never become a permission grant.

## Official references

- [Tradable asset pairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs)
- [Ticker information](https://docs.kraken.com/api-reference/market-data/get-ticker-information)

Verification is fixture-based, including alias matching, wrong quote currency, malformed fields, missing minimums, crossed quotes, oversized responses, stale retrievals and owner/agent/origin HTTP boundaries. No tests place live orders.
