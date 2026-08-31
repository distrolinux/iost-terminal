# Owner testing: MCP Apps and paper trading

This is the safe owner workflow for testing the PR #32 evaluation interface at
`https://iostcallister.com`. It is paper-only. Real-money orders, token
conversion, withdrawals, swaps and public-chain actions are not exposed by MCP.

## 1. Prove ownership without sharing secrets

Sign in at `https://iostcallister.com/app` and use the wallet-binding flow if
you want to prove ownership of an EVM wallet. MetaMask is an identity and
ownership signal only; it is not a broker trading connection. Never enter a seed
phrase, private key, or funded exchange secret into the site, an MCP client, or
an agent prompt.

## 2. Create a scoped paper agent

In Portfolio → AI Agents, create a per-user agent key with `read` and
`trade-paper` scopes. Keep the key in a secret manager and rotate it after
testing. Create an owned agent wallet with a small paper limit and an active
wallet-bound Pact that requires owner approval.

## 3. Connect an MCP client

Use `https://iostcallister.com/mcp` with the resource-bound OAuth flow (preferred)
or the `X-API-Key` header. Do not paste the key into a shared chat, browser URL,
screenshot, or client log. A client that supports MCP Apps can list the resource
and render `evaluation_review`; otherwise call the same evaluation tools and
inspect their JSON responses.

## 4. Verify evaluation history and paper execution

Call `evaluation_review` to load your private history, select up to two runs, and
inspect equity, drawdown, baseline and calibration charts. Use
`evaluation_export` to download deterministic JSON or CSV evidence and verify
the returned SHA-256 hash. Call `strategy_promotion_scorecards` to review the
0–100 strategy score, lifecycle recommendation, evidence confidence, benchmark
alpha, fold stability and remediation codes. Confirm that `applied` is false and
`executionPermissionsChanged` is false. Before a paper trade test, call the read-only
`paper_trade_preflight` tool with an explicit symbol, side, size, entry, owned
`walletId`, active `pactId`, protective `stop`, and the unique `intentId`
reserved for this attempt.
Set an explicit `maxSlippageBps` no greater than 100. Review its quote expiry,
multi-venue quorum, exclusions, best-price anchor, quality score, route latency,
rolling reliability, circuit state, price protection and failover reason;
bid/ask execution side, server-fill notional, estimated cost, portfolio exposure, concentration,
correlated sleeve, drawdown, daily loss, stop risk, volatility regime, dynamic
maximum order, portfolio capacity, limiting factor and machine-readable
authorization checks. If it allows the request, call
`paper_trade_open` with the same request, `intentId`, and returned
`preflightFingerprint`, then close it with `paper_trade_close`. Confirm the result
in the Paper account and revoke the agent key when finished.

## If you want a future live pilot

That is a separate security change, not an MCP Apps setting. It would require a
venue allowlist, withdrawal-disabled credentials, IP restrictions, tiny limits,
human confirmation for every order, audit logs, and a fail-closed review gate.
Until that change is explicitly designed and approved, do not connect a funded
exchange API key; it cannot be used by PR #32.
