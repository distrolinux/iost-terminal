# AITT Decision Evidence Graph

## Purpose

The AITT Decision Evidence Graph gives owners and compatible agents a compact,
private answer to three questions: what decision was made, which authoritative
evidence supported it, and how each guarded stage led to the next.

It combines the existing AITT Agent Evidence Passport and Agent Decision Trace.
It does not create a new source of truth, infer missing reasoning, persist a
second ledger, or change execution authority.

## Provenance profile

The portable JSON uses a small W3C PROV-inspired application profile:

- `Agent` represents the pseudonymous authenticated AITT principal.
- `Entity` represents the evidence passport and its hashed claims.
- `Activity` represents evidence assembly, decisions, and guarded stages.
- `used`, `wasAssociatedWith`, `wasDerivedFrom`, `wasGeneratedBy`, and
  `wasInformedBy` describe machine-verifiable provenance links.
- `wasPartOf` is an AITT extension that connects a stage to its decision.

This is intentionally not advertised as a formal RDF or PROV serialization.
The profile makes the graph understandable and portable without claiming
standards conformance that has not been independently validated.

## Integrity and privacy

Every graph is deterministically canonicalized with recursively sorted object
keys and protected by a SHA-256 evidence root. Verification detects any change
to nodes, edges, source-chain status, counts, or the latest decision summary.

The graph is private by default and owner-isolated. It uses pseudonymous graph
references and excludes raw owner, credential, wallet, Pact, mission, receipt,
and execution-intent identifiers. Missing evidence remains explicit.

The graph is never automatically published, anchored, tokenized, or shared.
An owner may download the portable JSON proof. That download is an
integrity record, not an identity credential, investment recommendation,
permission grant, token, NFT, or public-chain asset.

## Surfaces

- Owner UI: Agent Control Center → AITT Decision Evidence Graph.
- REST: `GET /api/agent-evidence-graph` (authenticated, private, no-store).
- MCP: `agent_evidence_graph` (authenticated, read-only).

All surfaces have zero execution authority. They cannot approve an order,
reserve funds, create a receipt, trade, enable live scope, or use a public chain.

## Deliberate boundary

OriginTrail's layered-memory and verifiable-knowledge ideas are useful design
inspiration, while W3C PROV provides durable provenance concepts. This release
adopts the local private graph and explicit derivation pattern only. A future
shared or public verification layer would require separate privacy review,
owner consent, threat modeling, legal approval, cost analysis, and an explicit
release gate.
