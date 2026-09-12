# Owner-private order draft review

The Live workspace includes an in-memory USD spot-buy limit draft form. It is
an arithmetic review, **not** an exchange preview, live preflight, recommendation,
proposal, approval or execution path. No provider credentials or market data are
accessed. No new MCP capability or live launch permission is added.

`POST /api/exchange-connections/order-review` requires an account owner session,
rejects user/platform agent keys, inherits same-origin mutation protection and is
rate limited. Responses are private/no-store. Draft inputs and results are not
persisted. No audit receipt, reservation or proposal is created by the operation.

Inputs are exactly `symbol`, `quantity`, `limitPrice`, optional `protectiveStop`
and optional `assumedFeeBps`. Prices and quantities are decimal strings with up to
eight fractional digits and ten integer digits; exponent notation and numeric JSON
values are rejected. Unknown fields cannot select an owner, provider or authority.
Only the current buy-limit draft shape is supported; asset/venue availability is
not implied by entering a symbol.

BigInt fixed-point arithmetic calculates notional and assumed fee/total. Products
round upward at eight USD decimals to avoid silently understating draft costs.
This precision is an arithmetic convention, **not** Kraken's price/lot increment.
Missing fees are unknown, never zero. Entered fee values are assumptions, not
verified venue fees. Loss to a drafted stop excludes fees and gaps, is not a maximum
loss guarantee, and does not arm any protective order. Slippage is not estimated.

Only the configured notional cap is compared. Cash, position limits, daily loss,
lot sizes, minimums, fees, permissions and tradability are not verified. Even a
within-cap result is always `not-authorized`. This projection does not call the
existing full execution rails or change them.

Review validity is 60 seconds, separate from approval expiry (which is absent).
Input edits invalidate the display and supersede pending responses; logout and
view changes prevent stale render. No draft survives a page refresh. There is no
submission/approval action, fingerprint accepted by execution, or retained plan.

Before any future live use, a separate venue-backed preview must verify actual
account permissions, tradability, units, fees and executable prices. Exact-order
owner authorization, replay protection, execution rails, reconciliation and all
public-live launch gates remain required. This release does not implement them.
