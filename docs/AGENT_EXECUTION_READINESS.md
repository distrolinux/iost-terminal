# Agent Execution Readiness Gate v1

IOST Terminal evaluates one deterministic, fail-closed gate before every new
agent-initiated paper position. The gate runs in server code; an agent cannot
weaken it by changing its prompt, omitting a mission, or skipping the status
tool.

## Required evidence

- The calling runtime is enrolled, ready, continuously supervised and healthy.
- A durable checkpoint exists, quarantine is inactive, and new exposure is
  permitted by the runtime lease.
- There are no open, critical or quarantined runtime incidents.
- The safety SLO is `warming-up` or `healthy` and its error budget is available.
- Existing positions have no degraded or unprotected Position Guardian state.
- Structured market evidence passes the Agent Data Trust Firewall.
- Emergency freeze is inactive.
- The caller has an active paper wallet and an active Pact bound to that exact
  wallet.

Any missing, malformed, unavailable or denied requirement blocks new exposure.
Owner manual paper trading is explicitly outside this agent-runtime gate and
continues through its existing session controls.

## Binding and replay safety

The complete sanitized readiness decision is included in the HMAC-bound paper
preflight fingerprint. `paper_trade_open` recomputes the gate immediately before
execution. Changed evidence rejects the request, and the resulting execution
receipt retains the readiness decision without storing wallet, Pact, runtime or
incident identifiers. Historical receipts without this new field remain
verifiable.

## Status surfaces

- MCP: `agent_execution_readiness` (private, read-only, non-destructive,
  idempotent)
- REST: `GET /api/agent-execution-readiness?symbol=IOST` (private, no-store)
- UI: Agent Control Center shows an owner-readable readiness summary. Final
  execution authorization is always recomputed during preflight and open.

Neither status surface creates an intent, reservation, receipt, position, live
action or public-chain action. The gate can only deny or preserve existing
authority; it cannot grant a scope or expand permissions.

## Standards alignment

- MCP tool safety: expose clear annotations and retain a human-visible control
  surface for consequential operations.
- OWASP LLM06 Excessive Agency: minimize autonomy, functionality and permissions,
  and require deterministic downstream authorization.
- NIST AI 600-1: monitor operational risk, provenance, incidents and human
  oversight as explicit evidence.

## Verification

```sh
node tests/agent-execution-readiness-check.mjs
node tests/mcp-http-integration-check.mjs
```
