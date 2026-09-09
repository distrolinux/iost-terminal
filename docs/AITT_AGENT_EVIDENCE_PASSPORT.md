# AITT Agent Evidence Passport

The AITT Agent Evidence Passport is a private, portable JSON proof bundle for an authenticated owner or agent. It connects the platform's existing authoritative evidence without creating a new source of truth.

## Evidence included

- effective paper permissions and wallet/Pact authorization;
- supervised runtime readiness, checkpoints and quarantine status;
- reviewed release provenance, dependency integrity and SBOM evidence;
- privacy-preserving Security Sentinel status;
- execution reconciliation and receipt-chain integrity;
- recent decision-trace coverage; and
- the newest retained benchmark and Challenge Lab evidence, when available.

Every claim has its own deterministic SHA-256 evidence hash. A canonical bundle hash becomes the passport evidence root. The subject is pseudonymous: raw user, credential, wallet, Pact, mission, receipt and trace identifiers are not returned.

## Interfaces

- `GET /api/agent-evidence-passport` returns the current caller's private no-store passport.
- `agent_evidence_passport` provides the same owner-isolated evidence through authenticated MCP.
- Agent Control Center displays the claims and lets the owner download the JSON locally.

## Boundaries

The passport is an integrity record, not a signed identity credential, investment recommendation, approval, permission grant, token, NFT or public-chain publication. It cannot execute, reserve funds, change authority, publish itself, enable live trading or bypass any current execution gate. Missing evidence is marked incomplete rather than inferred.
