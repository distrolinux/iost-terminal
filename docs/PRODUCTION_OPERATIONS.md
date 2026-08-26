# IOST Terminal production operations

This runbook covers monitoring, encrypted backups, and restore rehearsals for
`/docker/hermes-agent-ghfx/data/iost-terminal`. These scripts do not deploy,
restart the service, place trades, enable token functions, or perform public-chain
actions. Production deployment remains a separate, owner-approved step.

## Safety model

- `iost-terminal` remains the only writer to `data/`.
- A backup pauses that container only for the filesystem copy, then immediately
  resumes it. An exit trap attempts to resume it after every error or signal.
- Backups use GnuPG symmetric AES-256 encryption. The passphrase is read from a
  mode `0600` (or stricter) file and is never logged or passed as a literal CLI
  argument.
- Every archive contains per-file SHA-256 hashes. The encrypted artifact also has
  a checksum sidecar. GnuPG's integrity protection authenticates decryption.
- Restore refuses non-empty targets. Restoring to the production data path also
  requires `ALLOW_PRODUCTION_RESTORE=YES` and a stopped production container.
- Monitoring observes and alerts only. It never attempts automated remediation.

## One-time host setup

Create root-owned directories outside the Git checkout and a long random backup
passphrase kept in the password manager:

```bash
install -d -m 700 /docker/hermes-agent-ghfx/backups/iost-terminal
install -d -m 700 /docker/hermes-agent-ghfx/monitoring/iost-terminal
install -d -m 700 /docker/hermes-agent-ghfx/secrets
install -m 600 /dev/stdin /docker/hermes-agent-ghfx/secrets/iost-backup-passphrase
```

Paste the generated passphrase into the final command, press Enter, then `Ctrl-D`.
Do not reuse an application, exchange, wallet, or login secret.

Configure an **off-host** encrypted destination (a mounted remote backup volume or
an independently synchronized object-storage path) as `BACKUP_MIRROR_DIR`. A copy
on the same host protects against application mistakes but not total host loss.
Only encrypted `.gpg` files and their `.sha256` sidecars may leave the host.

## Scheduled backup and monitor

Create `/etc/iost-terminal-ops.env`, owned by root and mode `0600`:

```bash
BACKUP_PASSPHRASE_FILE=/docker/hermes-agent-ghfx/secrets/iost-backup-passphrase
BACKUP_MIRROR_DIR=/path/to/off-host-mounted-storage/iost-terminal
ALERT_WEBHOOK_CONFIG=/docker/hermes-agent-ghfx/secrets/iost-alert-webhook.curl
```

Store the private webhook URL in the root-owned mode `0600` curl config instead
of an environment variable or command-line argument:

```text
url = "https://your-private-alert-receiver.example/..."
```

Load that file from a root cron wrapper or systemd unit without printing its
contents. Recommended schedule:

```cron
*/2 * * * * set -a; . /etc/iost-terminal-ops.env; set +a; /docker/hermes-agent-ghfx/data/iost-terminal/scripts/monitor-production.sh
17 3 * * * set -a; . /etc/iost-terminal-ops.env; set +a; /docker/hermes-agent-ghfx/data/iost-terminal/scripts/backup-encrypted.sh
47 3 * * 0 set -a; . /etc/iost-terminal-ops.env; set +a; latest=$(find /docker/hermes-agent-ghfx/backups/iost-terminal -maxdepth 1 -name 'iost-terminal-backup-*.tar.gz.gpg' -type f | sort | tail -1); test -n "$latest" && /docker/hermes-agent-ghfx/data/iost-terminal/scripts/verify-backup-restore.sh "$latest"
```

The webhook receives only a short health summary; it never receives response
bodies, credentials, user data, or audit data. Alerting starts after three
consecutive failures and sends one recovery notification when checks pass again.

After configuration, run each command interactively once. Confirm a backup and
checksum exist in both local and off-host destinations, then run:

```bash
set -a; . /etc/iost-terminal-ops.env; set +a
scripts/verify-backup-restore.sh /docker/hermes-agent-ghfx/backups/iost-terminal/<backup>.tar.gz.gpg
```

Record date, backup filename, revision, result, and operator in the private
operations log. Never put secrets or restored user data in an issue or PR.

## Restore rehearsal (non-production)

Run monthly and after any backup-script change:

1. Select the newest encrypted backup and its checksum sidecar.
2. Copy both from off-host storage to a temporary root-only directory.
3. Run `scripts/verify-backup-restore.sh <backup-file>`.
4. Confirm it reports successful decryption, authentication, payload-hash
   verification, and isolated restore.
5. Record the result and remove the temporary encrypted copy.

The verifier creates and removes its own temporary restore target. It never
touches production data.

## Production restore (incident only)

Do not perform this section during a rehearsal. Obtain explicit owner approval,
record the incident, and identify the exact backup revision first.

1. Stop the application container and verify no other process writes `data/`.
2. Move the existing `data/` directory to a timestamped incident-hold path; do not
   delete it.
3. Restore into the now-empty production path:

   ```bash
   set -a; . /etc/iost-terminal-ops.env; set +a
   ALLOW_PRODUCTION_RESTORE=YES scripts/restore-encrypted-backup.sh \
     /secure/path/iost-terminal-backup-<timestamp>.tar.gz.gpg \
     /docker/hermes-agent-ghfx/data/iost-terminal/data
   ```

4. Inspect restored ownership and confirm files are mode `0600` and directories
   `0700`.
5. With explicit deployment approval, run the existing isolated preflight first:
   `PREFLIGHT_ONLY=1 ./deploy-host.sh`.
6. Start/deploy only the approved revision, verify internal and public health,
   authentication, owner paper account state, audit continuity, and paper-trading
   read paths. Do not exercise real orders or public-chain writes.
7. Keep the incident-hold data and restored backup until post-incident review is
   complete. Roll back by stopping the writer and swapping the preserved directory
   back, never by merging stores.

## Alert response

- **Container/public revision:** inspect `docker ps`, `docker inspect`, and the last
  100 container log lines. Do not print environment variables.
- **Backup age:** run the backup interactively, then the isolated restore verifier;
  confirm the off-host copy and checksum.
- **Disk:** identify growth with metadata-only commands first. Do not delete audit,
  session, user, or trading records ad hoc.
- **Recovery:** confirm the monitor sends one recovery notice and its state file
  remains root-only.
