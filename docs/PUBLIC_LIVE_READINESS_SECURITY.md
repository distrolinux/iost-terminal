# Public Live Readiness and Security Sentinel

IOST Terminal remains paper-first. Public access does not mean that real-money execution is automatically safe or permitted. The target live model is non-custodial: each eligible person controls their own supported venue account, while an agent may only propose an order inside owner-created limits.

## Current boundary

Real-money public execution is locked. Paper trading, market intelligence and read-only agent workflows remain available. Neither the readiness service nor the Security Sentinel can enable live mode, authorize an order, reserve funds, withdraw, transfer, trade, or expand an agent's authority.

## Launch gates

Every gate must pass before the platform may report `ready-for-controlled-canary`:

1. A complete, healthy Security Sentinel observation window.
2. Verified release provenance and dependency integrity.
3. A user-controlled venue connection.
4. Independently verified trade-only venue permissions with withdrawal and transfer permissions absent.
5. A dedicated production secret vault.
6. Unique, short-lived owner authorization bound to the significant data of each live order.
7. An independent security and execution audit.
8. Jurisdiction, eligibility and sanctions controls.
9. Documented legal and compliance approval.
10. Explicit production live-feature enablement.

Passing these gates permits only a controlled canary. It does not create global legal eligibility, remove venue restrictions, or authorize unattended execution. Live availability must remain jurisdiction- and venue-dependent.

## Security Sentinel

The initial sentinel is deliberately monitor-only and privacy preserving. It records bounded aggregate event kinds for authentication rejections, known automated path probes, rate-limit responses and server errors. It does not retain IP addresses, credentials, authorization material, request bodies or route parameters.

The sentinel uses a 15-minute assessment window, a 24-hour maximum retention period and a 5,000-observation memory bound. Infrastructure controls and the owner remain the enforcement authority. A high-severity finding fails the public-live security gate closed.

## Agent access

Authenticated read-scoped agents can inspect the same evidence through `agent_security_sentinel_status` and `public_execution_launch_readiness`. These tools are read-only, non-destructive and idempotent. No live-trading MCP tool or live scope is introduced.

## Operational rule

Do not set any live-readiness environment flag merely to increase the displayed completion percentage. Each flag is an attestation that its external control has actually been implemented and verified. Security audit and compliance approval must be supplied by qualified independent reviewers.
