# IOST Terminal

## Purpose

- Operate and evolve the IOST Terminal trading platform served at `iostcallister.com`.

## Ownership

- CALLY owns product, deployment, live-trading policy, and money-boundary decisions.
- Source, tests, docs, and runtime-safe scripts in this directory are project-owned.

## Local Contracts

- Security policy and vulnerability reporting live in `SECURITY.md`; it is binding alongside this file.
- Production is the only writer to `data/`; never start a second server against production stores.
- Real-money execution requires a signed-in human, enabled venue, hard order rails, and owner-approved agent proposals.
- Agent-wallet spending uses server-side limits and an active wallet-bound Pact; commit identity comes from the reservation, not the client.
- Secrets, reset tokens, private keys, and raw API credentials must never appear in source, responses, logs, or tests.
- Server and boot-cached page changes require a production container restart; static asset changes require cache-version bumps.

## Work Guidance

- Use failing regression tests before fixing execution, authorization, wallet, or authentication defects.
- Keep live tests read-only; never place or cancel real orders during automated verification.
- Use `IOST_DATA_DIR` scratch stores for tests where supported.

## Verification

- Run `npm test` for the offline safety suite.
- Run `node --check server.js` and syntax-check every changed JavaScript module.
- Run `npm audit --omit=dev --audit-level=high` before release.
- Verify production through `https://iostcallister.com/api/health`; do not boot a second production-data writer.

## Child DOX Index

- No child boundaries currently.
