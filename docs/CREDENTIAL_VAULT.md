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
persist. A reviewed sole-writer migration workflow must back up the user store,
call this function, persist using the existing store writer and verify recovery.
No public migration endpoint, background migration or production migration is
included. Do not rotate the legacy session secret until every required old record
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
provisioning, persisted migration and external security review remain required
before public credential onboarding.
