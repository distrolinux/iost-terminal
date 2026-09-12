# Credential lifecycle and recovery

This release does not enable onboarding or live execution. No existing backup is deleted.

## Fresh owner authentication

Saving, disconnecting and upgrading credential storage require the signed-in owner's password and configured TOTP or backup code. Agents cannot obtain or consume this authority. A proof expires after two minutes and is single-use, bound to the session, owner, chosen action, authentication state and saved credential state. Concurrent replay is rejected; process restart invalidates outstanding proofs. Existing provider verification and confirmation requirements still apply.

Pending onboarding candidates are encrypted in memory. A two-minute timer removes them without another request (subject to event-loop scheduling); request-time expiry is also checked. JavaScript memory cannot provide guaranteed zeroization. Authentication dialogs clear their fields and close on navigation or account changes.

## Recommended retention policy — operator implementation required

Target: retain encrypted credential backups for 30 days. Retire an older backup only after a newer replacement has passed an isolated recovery test and the owner has reviewed the deletion targets. If recovery has not passed, retain the backup under an explicit recovery hold and notify the owner. Do not silently extend an unresolved hold indefinitely: review it and resolve recovery or seek direction.

This is a documented operating policy, not an implemented automatic deletion schedule. Inventory on-server and off-host copies before applying it. Keep the encryption keys needed for every retained backup; legacy recovery may also require the old session secret. Disconnecting in IOST does not revoke a venue key or remove historical backups. Revoke retired keys at the venue separately.

## Recovery verification

The automated test uses synthetic keys and an isolated temporary directory. It verifies encrypted backup serialization, restrictive permissions, successful recovery with the matching keyring, and rejection of wrong keys, wrong owner and tampering. It does NOT verify production recovery.

Before opening credential onboarding to customers, an authorized operator must test a real encrypted backup and matching recovery keys in an isolated environment. Never restore over production, start a second production-data writer, contact an exchange, or print decrypted material. Verify decryption and expected owner/provider binding in memory; retain only a sanitized success/failure record and backup reference. Keep live credentials and all trading/chain actions disabled. Record the verified recovery date, applicable key version privately, retention holds and owner approval before any later deletion. Merely seeing the keyring file in a recovery volume is not a recovery test.

Disclosures and retention operations require owner review before customer onboarding is enabled; this document is not independent security or legal approval.
