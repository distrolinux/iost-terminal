# Focused product research — September 12, 2026

Official product documentation, not independent security validation or a ranking of vendors.

| Reference | Useful pattern | IOST adaptation / boundary |
| --- | --- | --- |
| [Capitalise.ai confirmation](https://support.capitalise.ai/en/articles/5982066-confirming-the-strategy) | Review entry/exit rules, limits and selected mode before starting | Next UX candidate: one plain-language strategy review built from server-validated structured rules. Drafts never authorize execution. |
| [Capitalise.ai slippage](https://support.capitalise.ai/en/articles/5963164-trading-slippage-and-how-it-affects-live-trading-simulated-trading-and-backtests) | Explicit differences between simulated and live fills | Show fees, slippage assumptions, missing data and sample coverage beside paper results; never imply guaranteed performance. |
| [Robinhood agentic trading](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) | Guided MCP connection to a dedicated agentic account; clearly described data access and account restrictions | Later: provider-specific connection checklist with exact scope/account boundaries. Keep our mandatory per-order human approvals; do not copy unconfirmed execution. No integration is claimed. |
| [Coinbase AgentKit architecture](https://docs.cdp.coinbase.com/agent-kit/core-concepts/architecture-explained) | Wallet providers separated from action providers and framework wrappers | Keep venue adapters separate from agent reasoning and server authorization. Do not install onchain action providers or add token/transfer capability for this upgrade. |

## Delivery order

1. Finish credential lifecycle security: fresh owner authentication, candidate expiry cleanup, truthful disclosures and recovery tests (this release, default-off onboarding).
2. Inventory the existing strategy composer and paper evaluation UI; consolidate them into a clear review flow rather than another dashboard. Show exact mode, account, limits, expiry, costs and blockers before any approval.
3. Add account-specific read-only fee/balance evidence only after the production credential recovery and operator review gates pass. Keep it distinct from provider order validation and real-money authorization.
4. Independently review security/execution and remaining launch gates before enabling any real-money route. No plugin or competitor feature replaces those gates.

These are product recommendations, not completed integrations. IOST Terminal identity, AITT pre-launch boundaries, paper/live separation, owner isolation and auditability remain unchanged.
