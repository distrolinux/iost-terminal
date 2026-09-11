# Owner Action Workbench

The Owner Action Workbench turns IOST Terminal's existing safety evidence into
one ordered, plain-language recovery plan. It appears at the top of the signed-in
Agent Control Center so an owner can answer **“What is blocking my agent?”**
without interpreting internal reason codes.

Version 2 adds the [Guided Safety Recovery Center](GUIDED_SAFETY_RECOVERY.md):
responsible actors, completion evidence, current-snapshot progress, historical
advisories, and an explicitly downloaded agent handoff without private IDs.

## Evidence composition

The workbench observes, but does not replace, these authoritative controls:

- Incident Center acknowledgement, recovery readiness and quarantine release
- supervised runtime health and durable checkpoint presence
- 30-minute post-recovery probation
- current fast and slow Safety SLO burn evidence
- Position Guardian coverage
- Data Trust Firewall authorization
- execution-ledger reconciliation
- emergency-freeze state
- exact paper-wallet/Pact authorization
- running mission and runtime-checkpoint binding

The server builds the ordered plan deterministically. Browser text is rendered
from this plan and does not invent recovery actions.

## Action classes

- **Requires you** — an owner-only decision such as reviewing a recovered
  incident or creating a paper authorization envelope.
- **System or operator task** — infrastructure must recover or authoritative
  evidence must become healthy.
- **Waiting for server evidence** — no click can safely accelerate the condition;
  the owner can inspect live evidence while the timer or burn rate clears.
- **Verified** — all observed prerequisites are ready for a fresh read-only
  paper preflight.

Navigation buttons lead directly to the relevant Control Center or Launchpad
section. Incident cards have keyboard-accessible disclosure buttons. A recovered
incident can be acknowledged or resolved from the workbench only after an
explicit confirmation; the Control Center then reloads the complete read-only
plan from the server.

## Security boundary

The plan itself is read-only. It cannot grant permissions, approve a Pact or
order, start a mission, change a runtime checkpoint, create a reservation, or
trade. Incident actions call the existing owner-session-only endpoints and can
only acknowledge evidence or restore previously granted paper authority after
the incident engine confirms recovery. Live trading, token actions, transfers,
withdrawals and public-chain actions remain separate and unavailable.
