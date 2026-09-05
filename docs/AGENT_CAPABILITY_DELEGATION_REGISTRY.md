# Agent Capability and Delegation Registry

IOST Terminal derives effective agent capabilities from independent,
server-owned authorization evidence. The registry is not a second grant store
and it never trusts a model, prompt, agent name, Agent Card, or self-declared
skill as permission.

## Authority intersection

Read capabilities require an active owner-created credential carrying `read`.
Paper preflight additionally requires `trade-paper` plus an active paper wallet
with an active Pact bound to that wallet. Paper execution also requires a ready,
supervisor-managed runtime with no quarantine. Mission checkpoints require a
running mission. Revocation removes every effective capability immediately.

Pacts supply owner approval and a time, budget, or goal completion boundary.
The registry reports missing evidence with stable reason codes and does not
automatically delegate, substitute an agent, create a mission, reserve funds,
or place a trade.

## Interfaces

- `GET /api/agent-capability-registry`
- MCP `agent_capability_registry_status`
- Agent Control Center capability card

The owner-session API shows the owner's registered agents. An agent-key request
and the MCP tool return only aggregate counts and the current principal's
sanitized capability evidence; other agent identities are not disclosed.

## Standards basis

- OAuth 2.0 Rich Authorization Requests (RFC 9396) separates coarse scopes
  from fine-grained authorization details and requires the authorization server
  and resource server to enforce the granted consent.
- MCP authorization requires resource-bound tokens and scope minimization, with
  incremental authorization rather than broad default access.
- A2A Agent Cards describe identity, capabilities, and skills but must not carry
  plaintext secrets; descriptive discovery metadata is not execution authority.
- NIST AI RMF Govern 3.2 and Map 3.3/3.5 call for explicit human/AI roles,
  documented scope, and defined human oversight.

References:

- https://datatracker.ietf.org/doc/html/rfc9396
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://a2a-protocol.org/v0.3.0/specification/
- https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
