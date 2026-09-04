# Agent Data Trust Firewall v1

IOST Terminal treats all external text, model output and tool output as data,
never as execution authority. The firewall is deterministic server policy and
does not depend on an agent obeying a prompt.

## Threat boundary

- RSS and other external text receives source/host validation, a SHA-256
  provenance hash and instruction-like-content screening.
- Suspicious text is replaced before it reaches an agent, excluded from
  sentiment scoring and retained only as sanitized reason codes and provenance.
- Lookalike domains, credential requests, role spoofing, instruction overrides,
  encoded payload markers, tool commands and financial commands are quarantined.
- Structured execution quotes use a fixed server source allowlist, schema
  validation, freshness and the existing multi-venue quorum.
- The trust decision and provenance hashes are bound into the HMAC preflight
  fingerprint. Evidence changes between preflight and open fail closed.

## Authority

The firewall cannot grant a scope, approve a wallet or Pact, start a mission,
reserve funds, place or close a trade, access live execution, or submit a public
chain action. A model statement, headline or tool response cannot authorize any
of those operations.

`agent_data_trust_status` and `GET /api/agent-data-trust` are read-only status
surfaces. They report aggregate quarantine counts, provenance coverage, policy
and execution-evidence checks without exposing raw suspicious content.

## Standards alignment

- OWASP LLM01:2025 Prompt Injection: segregate and identify external content.
- OWASP LLM05:2025 Improper Output Handling: validate before downstream use.
- OWASP LLM06:2025 Excessive Agency: keep authority in deterministic code.
- NIST AI 600-1: track content provenance and limitations.
- MCP tool security: validate tool results and treat annotations/output as
  untrusted unless they come from a trusted server.

## Verification

```sh
node tests/agent-data-trust-firewall-check.mjs
```

The acceptance path is paper-only and read-only. It must not create an intent,
receipt, reservation, position, live action or public-chain action.
