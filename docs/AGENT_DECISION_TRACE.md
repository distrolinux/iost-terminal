# Agent Decision Trace

IOST Terminal exposes a private, owner-scoped, read-only explanation of each retained paper decision. The trace is assembled from existing authoritative stores rather than model-generated narrative.

## Evidence pipeline

Each decision reports seven explicit stages: observe, analyze, risk-check, approval, execute, verify, and journal. A stage is marked `pass`, `block`, `pending`, `not-required`, or `unavailable`. Missing evidence is never inferred.

Receipt traces correlate fresh market and quote-quorum evidence, the sanitized order thesis, portfolio risk, Data Trust, execution readiness, exact owner approval, simulated fill, execution intent, receipt-chain verification, reconciliation, and the matching paper journal entry. Pending approval mandates appear before execution without being presented as completed trades.

## Interfaces

- Owner UI: **Trace** in the authenticated application.
- REST: `GET /api/agent-decision-trace?limit=25`
- MCP: `agent_decision_trace` with optional `limit` from 1 to 100.

The trace never approves, reserves, executes, retries, or changes authority. It excludes credentials and raw account, wallet, Pact, mission, approval, intent, receipt, reservation, and position identifiers. Live trading and public-chain actions remain unavailable through this surface.
