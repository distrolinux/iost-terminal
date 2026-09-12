# Dedicated credential encryption foundation

New Kraken credential writes require an independent vault keyring, rather than a
login-session secret. This is application-level envelope storage, not an external
KMS or a claim that the dedicated production secret-vault launch gate is satisfied.
Live onboarding and execution remain separately locked. No new MCP capability.

## Runtime configuration

Operators supply `IOST_CREDENTIAL_VAULT_KEYS` as a JSON mapping from key IDs to
canonical base64-encoded, independently generated random 32-byte keys, and
`IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID` as the ID for new writes. At most eight keys
are supported. Inject through approved secret management; never commit, log, paste
into chat, or copy key material into shell history. Do not reuse SESSION_SECRET.
No keyring is generated, provisioned, or enabled by this release.

AES-256-GCM uses a random 96-bit nonce and authenticated context binding version,
account ID, provider and key ID. Unknown versions, missing keys and tampering fail
closed. Ciphertext lives in the existing protected user store; no duplicate writer
or new plaintext store is introduced. The application process still has access to
decrypted credentials when authorized code needs them; this does not protect keys
against full process compromise.

## Compatibility and controlled migration

Legacy records remain readable with the original login-session secret. They retain
the old format's limitations until migration. Reads never silently migrate data.
New writes fail without a valid vault; they never fall back to session encryption.

`rewrapUserKrakenKey(user)` decrypts and seals a replacement in memory. It changes
the record only after successful sealing and preserves status fields. It does not
persist. The owner-session maintenance workflow below backs up the encrypted
credential and commits through the existing account store's sole writer.
No background migration or production migration is performed by installation.
Do not rotate the legacy session secret until every required old record
has been migrated and verified, or affected credentials will be unreadable.

For vault rotation, retain the previous key while adding a new active key, rewrap
and verify all records through the same reviewed migration workflow, and retain
older keys as long as encrypted backups need them. Test restore before retirement.
Never remove keys just because the active key changed. Backups and key material
must have separate restricted storage and a documented recovery procedure.

## Audit and tests

Connection, verification and removal append sanitized provider/outcome events to
the existing private audit trail. No credential fragments or raw provider payloads
are added. Audit events report activity, not new trading authority.

`tests/credential-vault-check.mjs` covers account/provider isolation, version
rejection, invalid configuration, key rotation, legacy reads, failed rewrap
preservation, and session-secret independence. It uses fixtures only. Operator
provisioning, supervised production migration and external security review remain
required before public credential onboarding.

## Private storage panel and owner-controlled upgrade

The Live workspace's existing private `GET /api/exchange-connections` includes a
whitelisted storage projection for only the signed-in account. It shows valid vault
configuration, envelope format and whether a migration appears needed. It does not
decrypt on GET or claim integrity from format alone. No key IDs, key values,
ciphertext, paths, or other owners' counts appear in the projection. Configuration
availability is not external KMS verification and changes no launch gate.

1. An operator first provisions the independent keyring through approved secret
   management, retaining the legacy session secret and any older ring keys. This
   release does not generate or provision secrets. Deploy code before planning
   migration; do not toggle live trading to enable maintenance.
2. The account owner opens Live → Credential storage → Run storage dry run.
   `POST /api/exchange-connections/kraken/storage-preview` decrypts and rewraps in
   memory, verifies a round trip, and retains only encrypted envelopes in a bounded
   process-local plan. No account write, backup, provider call or trade occurs.
3. Review and separately confirm “Back up & upgrade my credential.” The POST
   `storage-upgrade` requires that plan's unguessable token, the same owner and
   session, explicit confirmation, unchanged credentials, and a working active
   vault. Plans expire in five minutes, are one-use, and disappear on restart.
   Agent API keys are denied. Existing same-origin protection and rate limits apply.
4. Before any change, the server writes a unique encrypted credential-only backup
   under `IOST_DATA_DIR/credential-backups` (directory 0700, files 0600), verifies
   its bytes, and syncs it. Existing directories with unsafe permissions fail closed.
   Backups contain the owner reference and old envelope, never decrypted secrets,
   passwords, or full user records. They are private operational recovery material.
5. The synchronous sole writer prepares the full updated user store in a unique
   0600 temp file, verifies and syncs it, atomically renames it, updates memory,
   and syncs the directory. A pre-commit failure leaves the previous credential
   intact. A post-rename sync failure can mean the upgrade committed but durability
   is uncertain: refresh and inspect before further action; never blindly retry.
   The consumed plan cannot replay. Sanitized audit records report outcomes only.

No restoration or bulk-migration endpoint is exposed. No MCP tool is added.
The panel never requests key material. A valid format does not prove account
reachability; provider verification remains a separate read-only check.

## Recovery drill and retention

Before production migration, test a copy of the encrypted backup in an isolated
scratch store with the original session secret (legacy) or required keyring (v1).
Verify successful decrypt/round-trip internally without printing credentials. The
fixture recovery test demonstrates this path but is not proof of production backup
recoverability. Keep keys separate from backups and include this directory in the
restricted off-host backup policy; the application does not configure off-host
storage. Backups are never automatically deleted or keys automatically retired.

If rollback is needed, stop all production account-store writers during the owner-
approved maintenance window. Retain a current encrypted backup first, identify the
exact owner record, and restore only its encrypted credential field using a reviewed
operator procedure. Do not replace the full user store with an old copy, which could
roll back passwords, revocations or unrelated accounts. Start the sole writer and
verify privately. Do not run an offline migration against a running production store.
After migration, application rollback must retain vault-aware credential reads
(PR #89 or later); an older application cannot read the new envelopes. Do not
retire a compatible rollback image or required decryption keys during this rollout.

`credential-maintenance-check.mjs` tests confirmation, owner/session isolation,
expiry, replay, stale credentials, vault changes and backup failure. The separate
`credential-storage-check.mjs` uses scratch data for legacy migration, backup
read-back, recovery, permission checks, unrelated-user preservation and failed
atomic persistence. No real keys, accounts or provider requests are used.
`credential-maintenance-http-check.mjs` exercises owner-session preview, commit,
replay rejection, cross-origin protection, agent rejection and the unchanged live
lock through a fixture-backed local server.
