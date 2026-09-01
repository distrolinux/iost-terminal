# Agent Runtime Supervisor v1

Agent Runtime Supervisor is a small, deterministic companion process for Agent
Runtime Reliability. It continuously proves that the Hermes runtime is ready;
it is not an AI agent and owns no trading authority.

## Safety contract

- Reads the scoped API key from a read-only file. The key is never accepted on
  the command line, printed, or persisted in supervisor state.
- Persists the session identifier, exact checkpoint and pending heartbeat in a
  private 0600 file using atomic replacement.
- Writes the complete next heartbeat before sending it. If the response is
  lost after the server commits, the next cycle reconciles the server sequence
  instead of creating a duplicate mutation.
- A missing local state file may recover only when the prior runtime is
  `offline` or `draining`, using the exact server-issued checkpoint. It cannot
  take over a ready or degraded session.
- Uses a 20-second cadence, inside the server's 30-second recommendation and
  before its 45-second degraded threshold.
- On `SIGTERM` or `SIGINT`, records `draining` before exiting. Docker then owns
  process restart policy; the supervisor does not restart itself or Hermes.
- Heartbeats cannot grant scopes, release quarantine, start a mission, reserve
  funds, place trades, move tokens or touch a public chain.

## Operations

The production companion definition is
`ops/agent-runtime-supervisor.compose.yml`. Before first start, create the
dedicated state directory and assign it to the existing Hermes runtime UID/GID
10000. The definition runs as that non-root identity, drops every Linux
capability, uses a read-only root filesystem, mounts only the source, scoped
key and dedicated state directory, and includes a local health check.

Hermes may publish only its bounded mission context to the separate
`/opt/data/iost-runtime-supervisor-context.json` file, which the companion sees
read-only. The accepted shape is `{stage, missionId?, cursor?}`; it contains no
session identifier or credential. Missing fields preserve the last server
checkpoint, while an explicit null mission clears mission binding. Invalid or
unreadable context stops renewal and therefore fails closed.

Useful one-shot modes:

- `--once` records or renews one ready heartbeat
- `--drain` records one draining heartbeat
- `--check` reads only local state and exits unhealthy if the last server
  acknowledgement is stale, absent, or awaiting an exact retry

The normal mode runs continuously. Its logs contain only sanitized outcome,
runtime status and safety flags. Session and checkpoint identifiers stay in the
private state file.

## Server evidence

Supervisor-managed heartbeats include version and cadence evidence. Private
runtime status reports only `managed`, version, cadence, last acknowledgement
and health. The Agent Control Center shows whether each runtime is supervised;
it does not expose the local session identifier or API key.

The implementation follows Kubernetes' separation of startup, liveness and
readiness, Node's graceful signal handling, and Docker's recommendation to use
container restart policies rather than competing process managers:

- <https://kubernetes.io/docs/concepts/workloads/pods/probes/>
- <https://nodejs.org/api/process.html#signal-events>
- <https://docs.docker.com/engine/containers/start-containers-automatically/>
