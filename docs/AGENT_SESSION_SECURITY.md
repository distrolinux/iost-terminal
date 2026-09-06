# Agent Session Security

OAuth-ready IOST Terminal clients use an owner-created `itk_` credential to
authenticate at the token endpoint. Normal API and MCP work can then use a
short-lived, resource-bound bearer session. Direct `X-API-Key` authentication
remains available for backward-compatible agent clients.

## Security invariants

- Access sessions expire after 15 minutes.
- The server stores only a SHA-256 digest of each opaque token.
- Every token is bound to either the API root or the exact MCP resource.
- A requested `scope` must be a nonempty subset of the source key's scopes.
- MCP sessions always exclude `trade-live`, even if the source key has it.
- Revoking the source agent key invalidates every derived session immediately.
- Revoking a bearer session is terminal; a process restart invalidates all
  sessions by design.
- Session issuance never creates a wallet, Pact, mission, approval, reservation,
  receipt, position, trade, live action, token action, or public-chain action.

These controls implement least privilege in both capability and time. They also
follow MCP authorization's resource-indicator boundary: an API token cannot be
replayed at MCP, and an MCP token cannot be replayed at the API.

## Discovery and visibility

The read-only `agent_session_security_status` MCP tool and
`GET /api/agent-session-security` report sanitized counts, resource classes,
expiry posture and policy guarantees. Raw tokens, token digests, API keys,
owners and credential material are never returned.

The owner Control Center shows active, expired and revoked session counts plus
the enforced lifetime and binding posture.
