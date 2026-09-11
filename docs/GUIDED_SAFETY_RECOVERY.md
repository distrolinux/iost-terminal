# AITT Guided Safety Recovery Center

The existing Owner Action Workbench now presents one ordered recovery checklist
in the authenticated Agent Control Center. No additional Hermes allowlist entry
or new MCP tool is required. Its version 2 `workbench` response remains part of
the private, no-store `/api/agent-control` owner response.

## Owner journey

1. Read the next recovery step and its responsible actor.
2. Review the completion evidence before acting. Existing incident controls still
   require explicit confirmation and server authorization; other buttons navigate
   to the relevant existing controls.
3. Refresh recovery checks after the action. Progress is a current-snapshot count,
   not a persisted completion record, permission grant, or promise to execute.
4. Optionally download the agent handoff JSON. It contains guidance, not private
   incident, runtime, wallet, Pact, key, mission, or owner identifiers. Give it only
   to a trusted agent. It explicitly requires fresh authoritative checks.

## Evidence and ordering

Freeze and existing-position protection come first, followed by incident recovery,
runtime health, probation, operational burn, data trust, ledger reconciliation,
wallet/Pact authorization, mission validity and exact checkpoint binding.
The next action is always the first incomplete item in this same order.

An incident shortcut requires the affected runtime (not another ready runtime)
to have a healthy supervisor and durable checkpoint, plus recovery-ready incident
state. Server-side owner acknowledgment and resolution remain authoritative and
can reject a stale snapshot.

Missing fast/slow burn evidence and missing Guardian counts cannot produce a
ready plan. Explicit data-trust denial overrides a generic healthy status.
Expired Pacts and missions are excluded even if their retained status is active.
Multiple wallet/Pact/runtime pairs are matched by exact binding rather than list
position. This owner overview does not certify every agent or replace caller-bound
preflight authorization.

Probation shows the remaining time at the last server check, never an execution
ETA. Cumulative error-budget exhaustion and ticket burn are historical advisories;
fast/slow burn still blocks. A retained `preflight-evidence-changed` rejection
explains the need for fresh evidence without inventing a new current blocker.

## Boundaries

The plan is deterministic and has no stores or side effects. It does not create
Pacts, missions, heartbeats, approvals, reservations, or trades; it does not release
incidents automatically. Supervisor-owned sessions are never renewed by a competing
manual heartbeat. Paper/live separation, all execution gates, owner isolation and
Position Guardian are unchanged. There is no publication or token functionality.

## Validation

Regression tests cover unknown evidence, contradictory data trust, expiry, actor
binding, ordering, current-snapshot progress, historical advice and side effects.
The normal test suite and dependency audit apply before release.
