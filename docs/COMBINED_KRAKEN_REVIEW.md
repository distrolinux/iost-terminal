# Combined BTC/USD readiness evidence

The existing owner-only account-review route now gathers private cash/fee evidence,
public pair/ticker rules and public SystemStatus concurrently. No new trading or
MCP surface. Permission and credential isolation remain unchanged. A replaced
credential discards the entire response. Responses remain private, no-store.

One expiry is the earliest of 30 seconds from draft creation and the public evidence
expiries. Missing/stale evidence fails the freshness check; the UI invalidates edits
and expires the result. SystemStatus source timestamps older than 30 seconds or more
than 5 seconds ahead are rejected. Unknown engine modes and malformed advisory
arrays are unavailable; maintenance/advisories block the checked-evidence summary.

Clear evidence is explicitly NOT authorization. Eligibility, full risk, margin/final
fees, approval and live launch gates remain outstanding even when all listed checks
pass. A stop is only drafted, not armed. No funds are reserved. Balance is not shown.
Cash/fee assumptions and public market evidence are distinct in the details.

Offline tests cover missing, stale, future/invalid status, advisories, unsupported
modes, cash/cap failures, owner access and no execution. No real-account acceptance
or full live order lifecycle is claimed. Partial-fill/unknown-outcome execution
testing remains a separate next milestone, before any owner-approved live pilot.

Official source checked 2026-09-12:
https://docs.kraken.com/api-reference/market-data/get-system-status
