# Robinhood integration boundary — not integrated

Official documentation reviewed 2026-09-12:
https://robinhood.com/us/en/support/articles/agentic-trading-overview/

Robinhood describes a Trading MCP at https://agent.robinhood.com/mcp/trading
with trading limited to a dedicated Agentic account. Read access can include
other Robinhood accounts, their positions, balances, transactions and watchlists.
Provider availability and eligibility remain account/jurisdiction dependent.
This document is research and implementation planning, not a working connector.

## Recommended implementation sequence

1. Validate supported third-party application authentication, scopes, consent,
   revocation and provider terms. Do not assume that direct agent connection
   instructions authorize IOST to proxy tokens or execution for customers.
2. Build an owner-authorized, read-only connector first. Identify the exact Agentic
   account and filter all other account data from agent-visible responses. Never
   collect a brokerage password or expose tokens/account numbers in logs.
3. Discover and validate actual tool schemas. No guessed tool names, arbitrary
   remote tool proxy, or reliance on descriptions as an execution authorization.
4. Map supported orders into our closed mandate, explicit per-order human approval,
   expiry, account binding, limits, idempotency and reconciliation model. A direct
   Robinhood connection outside IOST does not inherit IOST's approval protections.
5. Test fills, fees, cancellations, timeouts, reconnects and permission revocation
   using fixtures, then approved provider testing. Keep live enablement separate.

Robinhood's documentation permits agents to trade without per-order confirmation
when users configure that behavior. IOST must retain mandatory human approval;
provider support alone does not enforce our policy. Do not add cards, transfers,
withdrawals, staking or lending to this trading integration.

Current implementation remains the plannedAdapters entry with status
`not-integrated`. No Robinhood authentication, discovery, orders, tokens or account
connections were performed. Crypto REST API documentation is a separate surface;
do not claim it provides the same account/product coverage as Trading MCP.
