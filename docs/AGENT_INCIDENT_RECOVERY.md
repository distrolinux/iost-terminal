# Agent Incident & Recovery Center

Version 1 adds durable, owner-visible incident handling to Agent Runtime
Reliability without adding trading authority.

## Safety model

- The server evaluates runtime health every 10 seconds, independent of an open
  browser or connected agent.
- A late heartbeat opens one deduplicated warning and blocks new mission
  exposure through the existing readiness gate.
- An expired heartbeat lease opens a critical incident and quarantines the
  runtime. Existing positions remain protected by Position Guardian.
- Three rejected session/checkpoint recovery attempts inside ten minutes also
  quarantine the runtime.
- Recovery detection does not release quarantine. The runtime must be ready,
  then an owner must acknowledge and resolve the incident.
- Acknowledgement and resolution are separate, audited owner actions. Multiple
  active incidents stack, so resolving one cannot release another incident's
  quarantine.
- Incident operations cannot grant wallet, Pact, mission, paper, live, token,
  withdrawal, or public-chain authority.

## Incident lifecycle

`open` → `recovery-detected` → `resolved`

Degraded-heartbeat warnings auto-resolve when health recovers. Critical offline
and repeated-recovery incidents require owner acknowledgement and resolution.
Every incident has a bounded structured timeline, occurrence counter, stable
reference, severity, reason code, and sanitized agent/runtime references.

## Owner interface and API

The Agent Control Center shows active and historical incidents, critical and
quarantine counts, recovery readiness, and gated acknowledgement/resolution
controls.

- `GET /api/agent-incidents` — owner aggregate, or the authenticated agent's
  own sanitized incidents
- `POST /api/agent-incidents/:id/acknowledge` — owner-only review record
- `POST /api/agent-incidents/:id/resolve` — owner-only resolution; releases only
  that incident's quarantine and only after runtime readiness returns
- `agent_incident_status` — private read-only MCP status for the authenticated
  owner/agent boundary

All responses are private and no-store. Durable state is atomically replaced,
owner-only (`0600`), identity-isolated, bounded, and fail-closed if corrupted.

## Operational guidance

Alerts are symptom-based and actionable: degraded latency, offline lease, or
rejected recovery. The initial notification channel is the owner control center,
which avoids noisy external paging while the paper-only system is being proven.
External routing can later consume the structured lifecycle without changing
the safety or execution model.

This design follows the incident preparation/detection/recovery lifecycle in
NIST SP 800-61 Rev. 3, symptom-oriented monitoring guidance from Google SRE,
deduplicated alert grouping principles used by Prometheus Alertmanager, and
structured event conventions from OpenTelemetry.
