# Agent Safety Playbook & SLO Center

Version 1.34 adds a read-only reliability decision layer over Agent Runtime
Reliability and Agent Incident & Recovery Center.

## Objective and evidence

The service-level indicator is **mission readiness**: enrolled runtime agent-time
that is ready and not blocked by an incident quarantine. The objective is 99%
over a rolling 30-day window. Evidence coverage is reported separately and the
result stays `warming-up` until at least one hour of agent-time exists; missing
history is never treated as proof of reliability.

Degraded and offline incident intervals count as unavailable. An offline interval
continues through recovery detection until the owner completes review because
new mission exposure remains quarantined. Recovery-failure intervals count from
quarantine application until resolution. Current degraded, offline, draining,
or quarantined state is also used as a fail-closed interval if an incident sweep
has not yet persisted evidence.
Overlapping intervals are merged so one outage is not double-counted.

## Error-budget burn

The Center uses multi-window, multi-burn-rate starting thresholds from Google
SRE guidance:

- fast: 14.4× over one hour and five minutes
- slow: 6× over six hours and thirty minutes
- ticket: 1× over three days and six hours

Both the long and short window must exceed a threshold. This improves precision,
detection time and reset behavior. It is particularly important for a low-volume
paper-agent service, where a single event can otherwise create noisy alerts.

## Deterministic playbooks

Active incident categories map to bounded instructions:

- late heartbeat: verify process/network and checkpoint; allow healthy automatic
  incident resolution
- offline runtime: verify Position Guardian, restart only the affected runtime,
  resume from the exact checkpoint, then complete owner review
- rejected recovery: stop retries, verify session/checkpoint, rotate the scoped
  key if compromise is suspected, recover once, then complete owner review

Playbooks are advice, not executable automation. They never acknowledge or
resolve incidents, release quarantine, modify authority, or trade.

## Interfaces

- `GET /api/agent-safety-slo` — private owner aggregate or authenticated-agent
  self view, with `private, no-store`
- `agent_safety_slo_status` — private read-only MCP tool
- Agent Control Center — availability, remaining budget, evidence coverage,
  burn windows and active playbooks

The output is deterministic, identity-isolated and derived from existing
sanitized runtime/incident evidence. Incident Center remains the sole quarantine
and release authority; Position Guardian continues protecting open positions.

The design follows Google SRE guidance for SLO-based multi-window burn alerts,
NIST SP 800-61 Rev. 3 response/recovery practices, and OpenTelemetry semantic
conventions for understandable, consistently named telemetry.
