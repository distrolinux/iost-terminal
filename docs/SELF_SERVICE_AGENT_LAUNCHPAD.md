# Self-service Agent Launchpad

The Agent Launchpad lets a signed-in user authorize a trading agent without a
platform operator. It is deliberately limited to paper trading.

## User flow

1. Create one account-owned agent wallet with a per-order limit, daily limit,
   time limit, and up to $100 of lifetime internal simulation credits.
2. Review and separately approve the proposed Pact as the signed-in human.
3. Create a revocable key scoped to `read` and `trade-paper`.
4. Copy the MCP endpoint and connection template into the agent client's secret
   manager. The secret is shown once and is never embedded in the template.
5. Observe decisions in Decision Trace. Pause the wallet, terminate the Pact,
   or revoke the key independently to stop future agent actions.

## Safety boundary

- Credits have no cash or token value and no withdrawal, conversion,
  public-chain, or live-order path.
- The lifetime automatic credit grant is stored on the parent wallet and capped
  at 10,000 USD minor units ($100).
- Setup is idempotent: it reuses the user's one Launchpad wallet and cannot mint
  repeat grants.
- A replacement Pact does not mint credits or alter the wallet policy.
- Agent credentials cannot create the wallet, propose Launchpad authority,
  approve a Pact, or manage another account's Pact.
- Agent paper execution still fails closed without `trade.paper`, an owned active
  wallet, an active wallet-bound Pact, and the existing server-enforced limits.

## Verification

Run `npm test`. The focused checks are:

- `tests/self-service-agent-launchpad-check.mjs`
- `tests/self-service-agent-launchpad-http-check.mjs`
