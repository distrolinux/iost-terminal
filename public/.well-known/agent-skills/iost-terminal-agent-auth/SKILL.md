---
name: iost-terminal-agent-auth
description: How an agent authenticates to IOST Terminal — API keys (X-API-Key), OAuth 2.0 client_credentials, scopes, and the human-in-the-loop live-trade proposal rail.
---

# Authenticating to IOST Terminal as an agent

IOST Terminal lets AI agents read market data freely and **act on an account
only with a scoped credential**. There are no CAPTCHAs and no default/shared
keys — fail-closed by design. Full guide: https://iostcallister.com/auth.md

## Credentials

A human mints an **agent API key** in the app (Portfolio → AI Agents):
- Format `itk_…` (32 random bytes, base64url); the full secret is shown
  **exactly once** — store it like a wallet seed.
- The key's public **id** is listed in the UI (used as OAuth `client_id`).
- Revoke instantly from the UI; revocation kills both the key and its tokens.

## Scopes

- `read` — always included; platform state for the bound account.
- `trade-paper` — open/close paper trades (`/api/paper/open|close`).
- `trade-live` — owner-only creation; **requests only** (see rails below).

## Option A — X-API-Key header

```bash
curl -H 'X-API-Key: itk_…' https://iostcallister.com/api/paper
```

## Option B — OAuth 2.0 client_credentials

Discovery: `/.well-known/oauth-authorization-server` (RFC 8414).

```bash
curl -s -X POST https://iostcallister.com/oauth/token \
  -d grant_type=client_credentials \
  -d client_id=<key-id> \
  -d client_secret=itk_…
# → { access_token, token_type: 'Bearer', expires_in: 86400, scope }
curl -H 'Authorization: Bearer <token>' https://iostcallister.com/api/paper
```

Tokens are opaque, in-memory, 24h TTL, same identity + scopes as the key.
Revoke: `POST /oauth/revoke` with `{ token }`.

## Live-trade rail (human-in-the-loop)

Agents **never execute live trades directly**. With `trade-live`:
1. `POST /api/live/proposals` `{ symbol, side, size, entry?, reason?, confidence? }`
2. Owner approves/rejects: `POST /api/live/proposals/:id/approve|reject`
3. Only an approved proposal reaches the venue, through the shared executor
   (rails: max order USD, max positions, daily loss cap).

## Verification

- `GET /api/health` — liveness.
- `GET /api/chain/status` — IOST trust-layer status (RPC reachability, pin key).
- A bad/missing key on a protected route → 401/403; public reads never need one.
