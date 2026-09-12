# Public real-money launch: remaining work

Code review baseline: PR #97 / 069c9e02d920, September 12, 2026. This is a work plan, not an audit certificate, legal determination or authorization. Paper availability and healthy deployment do not establish real-money readiness. No gates are changed by this document.

## Important evidence distinction

`publicLiveReadinessFor` in `server.js` combines runtime evidence with operator flags for vault readiness, transaction authorization, independent audit, jurisdiction controls and compliance approval. Those flags are declarations: setting them does not implement or independently verify the underlying controls. They must remain false until documented evidence and owner review justify them. A configured Kraken key is not verified permission evidence; a local encryption round trip is not production recovery or external vault certification.

## Ordered work and acceptance criteria

| Order | Work | Responsible party | Evidence needed before completion |
| --- | --- | --- | --- |
| 1 | Production credential recovery and retention operations | Authorized operator + owner; agent can build fixture tooling | Restore a real encrypted backup in isolation using recovered keys; no exchange calls or secret output. Inventory server/off-host copies and implement reviewed 30-day retention with recovery holds. A fixture-only pass is insufficient. |
| 2 | Read-only onboarding canary | Owner + operator, after security/disclosure review | Dedicated owner-provided read-only key, fresh authentication, negative permission tests, safe disconnect and key revocation instructions. Never enter credentials in agent chat. Default-off customer onboarding stays off until approved. |
| 3 | Account-specific evidence | Agent implements against official venue schemas; owner provides authorized test access separately | Fresh fees, spendable funds, pair/account eligibility and provider/system status, with bounded requests, owner isolation, redacted logs, failure/timeout fixtures and explicit missing evidence. Public quotes alone are insufficient. |
| 4 | Live order lifecycle validation | Agent builds/tests; owner and independent execution reviewer approve | Exact action/account/amount/price/expiry-bound owner authorization; replay and changed-evidence rejection; durable idempotency, unknown-outcome handling, partial-fill/cancellation reconciliation and position protection. Test with mocks or a supported sandbox first; no real order from this plan. |
| 5 | Operational resilience | Operator + agent for test tooling | Restore rehearsal, monitoring/alert delivery test, stale-heartbeat recovery, rollback and emergency-stop runbooks, load testing against scratch stores. Monitor-only sentinel status is not a penetration test or WAF. |
| 6 | Independent security and execution review | Independent qualified reviewer | Written scope, findings, remediation and retest evidence covering tenant isolation, vault/keys, auth, approvals, venue integration and recovery. Developer tests are not independent approval. |
| 7 | Eligibility, jurisdiction and disclosures | Owner + qualified counsel/compliance reviewer | Written applicability review for intended markets/providers, implemented applicable controls and verified restriction behavior. Do not claim worldwide availability or decentralization removes these obligations. |
| 8 | Controlled live canary, then rollout review | Owner + operator only after all applicable gates pass | Separately approved venue/account/order limits, monitoring and stop criteria; explicit approval at transaction time. Record reconciled outcome before considering broader access. Passing readiness is not an instruction to submit an order. |

## Next engineering increment

After this readability patch, inventory the existing Kraken broker and proposal paths against step 4 before adding another execution path. Prepare step 3 schema/fixture tests in parallel with the owner's recovery and external review work only when the required access and provider behavior are established. Do not unlock a gate to make a dashboard look complete.

Keep Robinhood marked not integrated until validated. No new venue plugin, autonomous spending, withdrawals, transfers or AITT release is authorized by this plan. AITT retains its separate release process.

Related: [credential recovery](CREDENTIAL_RECOVERY_AND_RETENTION.md), [exchange connections](EXCHANGE_CONNECTIONS.md), [security policy](../SECURITY.md).
