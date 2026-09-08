# Agent Event Stream

IOST Terminal exposes a private, resumable operations stream for account owners and their read-scoped agents. It gives humans, Codex, Hermes, and other MCP clients the same ordered view of paper-agent activity without granting execution authority.

## Interfaces

- `GET /api/agent-events?afterSequence=<n>&limit=<n>` returns a bounded replay snapshot.
- `GET /api/agent-events/stream` opens a Server-Sent Events connection.
- `Last-Event-ID` or `afterSequence` resumes the stream after a disconnect.
- `agent_event_stream_status` provides the same replay and integrity evidence through MCP.

The stream sends `agent-event`, `ready`, `gap`, and `heartbeat` events. Agent events carry monotonically increasing per-owner sequence numbers. Transport heartbeats are sent every 15 seconds and do not advance the durable cursor.

## Failure and replay semantics

The server retains a bounded history per owner. A cursor older than the retained window emits an explicit `gap` event and resumes at the earliest available sequence; it never silently pretends the replay was complete. Concurrent events arriving during initial replay are buffered and emitted once in sequence.

Each retained history is an anchored SHA-256 chain. Trimming advances the private anchor to the last removed hash, preserving verification of the remaining window. Corrupt or unsupported state fails closed.

## Privacy and authority

The store is mode `0600` and keyed by a one-way owner reference. Events contain sanitized summaries, category, actor, outcome, status, and a small metadata allowlist. Credentials and raw account, wallet, Pact, mission, intent, receipt, reservation, and position identifiers are excluded.

The event stream is observation-only. It cannot approve a request, reserve funds, create a receipt, open or close a trade, expand authority, enable live trading, move tokens, or perform a public-chain action. The existing public market-data SSE channel remains separate.
