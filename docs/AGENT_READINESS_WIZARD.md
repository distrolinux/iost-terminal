# Agent Readiness Wizard

The Agent Readiness Wizard gives an owner one honest path from an empty account to a supervised paper-trading preflight. It combines existing server evidence without creating authority or performing an execution action.

## Readiness stages

1. **Safety budget** — an active paper-only wallet exists.
2. **Owner permission** — an active Pact is bound to that exact wallet.
3. **Scoped access** — a revocable credential has only `read` and `trade-paper` access.
4. **Connected client** — the paper credential has authenticated, or an active MCP session is resource-bound with both paper scopes.
5. **Supervised runtime** — the runtime supervisor is healthy, resumable, and not quarantined.
6. **Bound mission** — a running mission is bound to the wallet, Pact, and runtime checkpoint.
7. **Safety gate** — incidents, fast and slow SLO burns, Position Guardian, emergency freeze, and release trust are clear.

The first incomplete stage supplies one deterministic next action. Later evidence remains visible so an owner can diagnose readiness without allowing a later stage to bypass an earlier one.

## Safety boundary

The wizard is advisory-only. It cannot create wallets, Pacts, credentials, sessions, missions, reservations, receipts, positions, or trades. It cannot approve an exception, change execution permissions, expand authority, use live scope, or perform a public-chain action. A successful wizard result authorizes only a fresh read-only preflight; all normal execution controls still apply afterward.
