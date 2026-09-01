# Agent Runtime Reliability v1

Agent Runtime Reliability gives a paper-trading agent a durable, observable
lease without giving it any new trading authority. It separates process
liveness from permission to open new mission risk and makes restart recovery
resume from an exact server-issued checkpoint.

## Safety contract

- Paper-only. Heartbeats cannot add scopes, approve a Pact, create a mission,
  reserve cash, place a trade, move a token, or write to a public chain.
- A heartbeat is owner- and agent-key-bound. Session identifiers are hashed in
  private storage and never returned through status APIs.
- Sequence numbers are monotonic and idempotent. Repeating the same sequence
  and payload returns the original checkpoint; changing a used sequence is
  rejected.
- A replacement session is rejected while the current session is healthy. Once
  it is draining or offline, recovery requires the exact last checkpoint and a
  matching checkpoint mission, with a new sequence beginning at one.
- Once an agent enrolls, new mission-scoped exposure fails closed if its lease
  is degraded, offline, draining, or bound to another mission.
- Existing positions remain protected by Position Guardian independently of
  runtime health. Losing the agent cannot disable stops or OCO exits.
- Missing legacy enrollment does not interrupt existing integrations. The gate
  becomes mandatory for that key after its first heartbeat.
- Corrupt or unsupported runtime safety state stops the service at load instead
  of silently treating enrolled agents as legacy agents.

## Health and checkpoint model

Agents should heartbeat every 30 seconds. A lease is `ready` through 45 seconds,
`degraded` through 90 seconds, and `offline` afterward. Agents may report
`idle`, `observe`, `analyze`, `risk-check`, `execute`, `verify`, or `journal` as
their checkpoint stage. `draining` announces a deliberate handoff.

Every accepted heartbeat records a new opaque checkpoint with its mission,
stage, bounded cursor, sequence, and timestamp. The checkpoint is evidence for
safe continuation; it is not an authorization token and cannot bypass wallet,
Pact, mission, preflight, portfolio-risk, or execution controls.

## Agent interface

`agent_runtime_status` is private, read-only, non-destructive, and idempotent.
An agent sees its own runtime; an owner session sees a sanitized aggregate.

`agent_runtime_heartbeat` is private, idempotent, and non-destructive. It accepts
`sessionId`, `sequence`, `state`, `stage`, optional `missionId`, optional bounded
`cursor`, and—only for recovery—`resumeFromCheckpointId`. A deterministic
supervisor may also report version 1 and a cadence between 5 and 30 seconds;
these are operational evidence only and cannot expand authority.

For continuous operation use the least-privilege companion documented in
`AGENT_RUNTIME_SUPERVISOR.md`. Manual one-shot heartbeats are intended for
testing and do not provide durable readiness evidence.

The owner REST surface is `GET /api/agent-runtime`; agent-key heartbeats use
`POST /api/agent-runtime/heartbeat`. Both are private and `no-store`.

## Protocol alignment

The design follows the operational separation used by Kubernetes probes:
liveness determines whether a process is alive, while readiness determines
whether it should receive work. It also follows AWS Step Functions' bounded
heartbeat/timeout model and exact retry discipline. The pollable runtime status
and durable checkpoint model are compatible with the direction of MCP Tasks,
while remaining a small first-party primitive that does not depend on draft task
support in every client.

- Kubernetes probes: <https://kubernetes.io/docs/concepts/workloads/pods/probes/>
- AWS Step Functions task heartbeats and timeouts:
  <https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html>
- AWS Step Functions reliability practices:
  <https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html>
- MCP Tasks extension: <https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks>
- OWASP LLM06:2025 Excessive Agency:
  <https://genai.owasp.org/llmrisk/llm062025-excessive-agency/>

## Acceptance requirements

1. Initial enrollment creates a private 0600 state file and opaque checkpoint.
2. Exact heartbeat replay returns the same checkpoint; collision and stale
   sequence attempts fail.
3. Degraded, offline, draining, and mission-mismatched runtimes cannot open new
   mission exposure.
4. A replacement session cannot take over a healthy lease and cannot recover
   without the exact last checkpoint.
5. Status output omits raw agent-key and session identifiers and remains
   owner-isolated.
6. Corrupt safety state fails at load.
7. Runtime actions never create a reservation, receipt, trade, live action, or
   public-chain action.
