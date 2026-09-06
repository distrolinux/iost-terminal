# Agent Release Trust

IOST Terminal fails closed when the running application cannot prove that it
matches the reviewed release inputs. This control is read-only and does not
grant trading authority.

## Evidence

- The production dependency tree is locked and every package has npm integrity evidence.
- The Node base image is pinned by SHA-256 digest, not only by a mutable tag.
- GitHub Actions dependencies are pinned to full commit SHAs with read-only repository permissions.
- CI generates, validates and retains a CycloneDX production SBOM for 90 days.
- Deployment refuses dirty trees and records the Git revision, package-lock hash and Dockerfile hash as image labels.
- The candidate receives the expected hashes and verifies them against its own files.
- Isolated candidate health, exact public revision health and automatic rollback remain mandatory.

## Interfaces

- `GET /api/agent-release-trust`
- MCP read-only tool `agent_release_trust_status`
- Agent Control Center → Agent Release Trust

The status is `verified` only when every required control passes. Tokens,
credentials and private owner data are never included.
