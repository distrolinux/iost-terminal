# Secure read-only Kraken onboarding

This release implements first-connection enrollment, not live execution. Operators must explicitly set `KRAKEN_READONLY_ONBOARDING_ENABLED=1` in the production environment **and** configure the dedicated credential vault. The default is disabled. This flag never sets any live launch gate or trading flag. Production enablement is a separate owner-approved action; do not enable trading to unlock credential storage.

Before enabling this beyond fixtures, complete the operational security review and update/review public privacy disclosures that currently describe a paper-only service without exchange credential collection. Deploying this default-off code is not authorization to collect customer credentials.

## Owner workflow

1. Sign in normally, including configured account 2FA. Open Real Money → Exchange Connections.
2. Create a separate Kraken **read-only** API key with Query Funds access. Do not reuse a trading or funding key. API-key 2FA is not supported by this flow; do not weaken an existing key to work around that limitation.
3. Enter credentials only in the signed-in first-party form and consent to verification. Never send credentials through chat, an agent, or a screenshot.
4. Verification uses fixed Kraken GetApiKeyInfo and Balance endpoints only. Unknown permissions, trading, withdrawals and transfer permissions prevent enrollment. Balances and raw provider payloads are never returned or persisted. Account-specific fee checks are not implemented by this release.
5. The form clears after submission. The server holds only an encrypted candidate in a bounded in-memory confirmation map. Verify and confirm encrypted storage within two minutes in the same owner session. No account credential is saved during preview.
6. Disconnect removes the active IOST credential atomically. It cannot revoke the key at Kraken or erase historical encrypted backups. Revoke the API key in Kraken when retiring it. Existing orders or positions at Kraken are not cancelled by disconnecting.

Existing credentials cannot be overwritten. This release accepts only read-only keys; a later trade-capable enrollment policy must be separately reviewed. Connection metadata explicitly does not satisfy the least-privilege **trading** permission gate. Connected, verified, stored and authorized are separate states.

## Controls and recovery

- Owner-session-only endpoints, agent/platform-key rejection even with cookies, same-origin mutation protection, rate limiting and closed request schemas.
- Account-bound AES-GCM vault envelope, roundtrip verification, two-minute single-use confirmation bound to owner/session/password state and active vault key. Restart, expiry, password change or changed credentials invalidate the candidate.
- Twenty in-flight previews and one hundred pending encrypted plans maximum. No plaintext candidate storage or provider errors in response/log output. JavaScript strings cannot be reliably zeroized; memory clearing is best-effort, not a zeroization guarantee.
- Atomic sole-writer credential/status commit and deletion. A post-rename durability failure is reported as unconfirmed: refresh status rather than blindly repeating the operation.
- Legacy direct PUT credential saving is disabled, even if live mode is enabled. Use the reviewed enrollment path; no permission-validation bypass through the old account form.
- No automated re-verification, trade, cancellation, wallet/mission change or public-chain action. Future trading must re-check permissions and authorization at execution time; a previously read-only key can be changed externally by its owner.

Fixture tests cover denied enrollment, unsafe permissions, wrong owner/session, expiry, replay, changed password, no plaintext at rest, no preview writes, deletion and HTTP authentication/origin boundaries. No real credentials are used.

Official provider reference: [Get API Key Info](https://docs.kraken.com/api-reference/account-data/get-api-key-info). The observed permission vocabulary is allowlisted; unrecognized permissions fail closed.
