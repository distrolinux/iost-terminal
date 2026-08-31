# Agent Mission Control v1

Mission Control turns a scoped paper-agent connection into a supervised,
time-bounded operating envelope. It does not enable live trading, tokens,
withdrawals, venue credentials, or public-chain actions.

## Authority chain

A mission can be created only by the platform owner while signed in. It binds
to one active `trade.paper` wallet and the exact active Pact for that wallet.
Starting a paused mission revalidates both objects. Every mission paper order
continues through the existing wallet-limit and Pact reservation/commit rail.

The mission adds these server-enforced limits:

- symbol allowlist;
- maximum notional per paper order;
- maximum number of opened positions, including in-flight reservations;
- realized-loss halt;
- fixed expiry no later than seven days or the Pact expiry;
- paper-only wallet capability (a wallet carrying `trade.live` is rejected).

Mission order capacity is reserved before asynchronous paper execution and
committed only after the paper position and wallet/Pact settlement succeed.
This prevents concurrent requests from exceeding the configured trade count.

## Operating flow

The cockpit displays the common evidence pipeline:

1. Observe
2. Analyze
3. Risk check
4. Execute
5. Verify
6. Journal

A user-bound MCP agent can read `paper_missions` and append bounded evidence
with `paper_mission_checkpoint`. It cannot create, start, pause, stop, expand,
or rebind a mission. A mission-aware `paper_trade_open` includes a unique
retry-safe `intentId` plus `missionId` in addition to its exact `walletId` and
`pactId`. The mission order also carries its bound preflight fingerprint and
maximum-slippage ceiling; mission budget authorization uses the server bid/ask
fill notional rather than the client's requested reference price.

`paper_missions` returns a deliberately sanitized evidence view rather than the
owner-control record. It includes the symbol allowlist, USD limits and usage,
paper-only boundary, expiry, latest checkpoint, and current revalidated
authority booleans such as `exactWalletPactBinding` and `canOpenPaperTrade`.
Wallet IDs, Pact IDs, owner IDs, position IDs, reservation IDs and secret
material are excluded. `paper_mission_checkpoint` returns the same sanitized
view after accepting a bounded checkpoint.

Only `within-pact` execution is active in v1. Per-order and exception approval
queues remain visibly unavailable until their server-side proposal workflows
are implemented; the backend rejects execution under those modes.

## Emergency behavior

The existing owner emergency stop now also stops every running or paused
mission before suspending agent wallets and disabling live execution. Closing
an existing paper position remains risk-reducing and records realized mission
P&L. Reaching the mission loss limit pauses the mission automatically.

## Verification

- `node tests/agent-mission-control-check.mjs`
- `node tests/mcp-2026-paper-agent-check.mjs`
- `npm test`

All automated verification is offline/paper-only. It must not place or cancel a
real order or submit a public-chain transaction.
