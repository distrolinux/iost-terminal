# Multi-Agent Portfolio Orchestrator

IOST Terminal coordinates every paper execution through a deterministic, account-scoped arbiter. It prevents independent agents from racing the same paper ledger while preserving execution-intent idempotency and verified receipts.

## Guarantees

- One active paper writer per account, with a bounded FIFO queue.
- Risk-reducing closes take priority over queued new exposure; active work is never interrupted.
- Agent opens fail closed when they would create opposing long/short exposure in the same symbol.
- Multiple missions may observe the same symbol, but cross-wallet overlaps are surfaced to the owner as an advisory conflict.
- Agent substitution is never automatic. Fallback requires the same capabilities and explicit owner approval.
- Process restart recovery remains grounded in durable execution intents, verified receipts, reconciliation, and Position Guardian—not transient queue memory.
- The status API and MCP tool are private, read-only, non-destructive, paper-only, and do not expose wallet, Pact, owner, position, or intent identifiers.

## Interfaces

- `GET /api/agent-portfolio-orchestrator`
- MCP `agent_portfolio_orchestrator_status`
- Agent Control Center coordination card

## Design basis

The design follows centralized multi-agent arbitration with explicit capability routing and deterministic conflict resolution; saga-style idempotent participants; FIX allocation principles that preserve individual execution identity; and NIST AI RMF human-oversight and role-responsibility guidance.

- AWS Well-Architected Agentic AI Lens, REL04: https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel04.html
- AWS Prescriptive Guidance, Saga orchestration: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html
- FIX Trading Community, Post-Trade allocation: https://www.fixtrading.org/online-specification/business-area-posttrade/
- NIST AI RMF Core: https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
