# PR #31 — MCP 2026 paper-trading agents

Status: implementation candidate. This document does not authorize merge, deployment,
live-money execution, token activity or public-chain writes.

## Outcome

IOST Terminal exposes a stateless MCP 2026-07-28 endpoint at `POST /mcp`. Public
clients receive market and platform read tools. A credential bound to one IOST Terminal
user and the MCP resource can receive private paper-account and causal-evaluation tools.
The `trade-paper` scope additionally reveals simulated open/close tools.

The server retains bounded 2025-06-18 compatibility for existing clients. Modern
requests use per-request protocol metadata and routing headers, deterministic JSON
Schema 2020-12 tool definitions, structured results and the Tasks extension for longer
evaluation runs.

## Authorization and privacy

- Tool discovery is least privilege. Unauthorized tools are absent and execution is
  independently authorized again on every call.
- OAuth access tokens are audience-bound: a token minted for `/mcp` cannot be replayed
  against the REST API, and a REST token cannot be replayed against `/mcp`.
- Private evaluations, account data and durable task handles are owner-bound. Task IDs
  are opaque, are retained with a limit and TTL, and cannot be listed or read by another
  user.
- Durable task state uses an atomic, mode-0600 local store. Audit attribution covers
  both platform and per-user agent credentials.
- Input schemas reject unknown properties, invalid types and over-deep structures before
  any tool executor runs.

## Paper-execution boundary

An MCP paper open requires all of the existing server-side controls:

1. a per-user agent credential with `read` and `trade-paper`;
2. a positive explicit entry and size;
3. an owned, active agent wallet;
4. an active Pact bound to that wallet; and
5. a successful budget reservation and settlement.

Failures roll back the simulated position. The explicit paper entry is used without a
network quote lookup, making evidence deterministic while preserving the existing paper
fill authority.

There are deliberately no MCP tools for live orders, real-money movement, token issue or
conversion, swaps, wallet sends, or public-chain mutation. Existing paper-review and
evaluation evidence gates remain unchanged.

## MCP Apps and Skills decision

The official MCP Apps extension is a good fit for a future in-client Evaluation Review
App: equity/drawdown/baseline/calibration charts, evidence exports, authorization status
and paper order previews can be rendered in a sandboxed client panel. PR #31 returns
typed `structuredContent`, so that UI can consume the same deterministic evidence later.

This PR does not advertise an Apps or Skills extension that it does not fully implement.
A follow-up should add a bundled `ui://` resource, strict content security policy, no
external origins, accessible chart tables, and an explicit confirmation step for paper
orders. The UI must call the same server tools and cannot bypass wallet/Pact checks. Live,
token and public-chain tools remain out of scope.

## Verification

The regression suite covers modern header matching, least-privilege catalogs, schema
validation, OAuth audience isolation, cross-user task denial, durable cancellation,
wallet/Pact enforcement, and a real HTTP paper open/close round trip. The full offline
safety suite, syntax checks, dependency audit and diff checks are required before the PR
is published.
