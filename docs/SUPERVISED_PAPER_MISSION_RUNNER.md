# Supervised Paper Mission Runner

The Supervised Paper Mission Runner gives AI agents and owners one deterministic view of a mission's execution workflow. It composes the platform's existing safety evidence; it does not replace or bypass any execution control.

## Workflow

1. Observe fresh market evidence.
2. Analyze the mission symbol.
3. Run the read-only paper preflight.
4. Wait for owner approval when the mission requires it.
5. Submit the exact idempotent paper order through the existing execution tool.
6. Verify the tamper-evident receipt and Position Guardian state.
7. Journal a bounded mission checkpoint.

The `paper_mission_runner_status` MCP tool returns the current stage, prerequisite checks, the next permitted tool, the responsible actor, and a six-stage timeline. It is read-only, deterministic, paper-only, and safe to poll after an agent or host reconnects.

## Trust boundary

- It never places, approves, retries, or closes a trade.
- It never reserves cash or creates an execution intent or receipt.
- It does not grant wallet, Pact, mission, or live-trading authority.
- Existing preflight fingerprints, owner approval mandates, idempotency keys, reconciliation, runtime supervision, and Position Guardian checks remain authoritative.
- Missing mission, runtime binding, reconciliation, protection, or authorization evidence fails closed with a machine-readable reason code.

This contract is designed for model and framework portability: Codex, Hermes, and other MCP-capable agents receive the same server-authored next-action state without relying on prompt memory.
