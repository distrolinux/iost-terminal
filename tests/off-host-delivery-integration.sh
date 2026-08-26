#!/bin/bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/iost-delivery-test.XXXXXX")"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$SCRATCH/backups" "$SCRATCH/bin"
BACKUP="$SCRATCH/backups/iost-terminal-backup-20260826T031700Z.tar.gz.gpg"
printf '%s\n' 'encrypted-test-payload' > "$BACKUP"
(cd "$SCRATCH/backups" && sha256sum "$(basename "$BACKUP")" > "$(basename "$BACKUP").sha256")

printf '%s\n' \
  '#!/bin/bash' \
  'set -eu' \
  'printf "%s\n" "$*" >> "$FAKE_TAILSCALE_LOG"' \
  'attempts=$(wc -l < "$FAKE_TAILSCALE_LOG")' \
  'if [ "${FAKE_FAIL_UNTIL:-0}" -ge "$attempts" ]; then exit 1; fi' \
  > "$SCRATCH/bin/tailscale"
printf '%s\n' \
  '#!/bin/bash' \
  'set -eu' \
  'printf "%s\n" "$*" >> "$FAKE_ALERT_LOG"' \
  > "$SCRATCH/bin/curl"
chmod 700 "$SCRATCH/bin/tailscale" "$SCRATCH/bin/curl"
printf '%s\n' 'url = "https://alerts.invalid/hook"' > "$SCRATCH/alert-webhook.curl"
chmod 600 "$SCRATCH/alert-webhook.curl"

DELIVERY_ENV=(
  "PATH=$SCRATCH/bin:$PATH"
  "BACKUP_DIR=$SCRATCH/backups"
  "DELIVERY_STATE_DIR=$SCRATCH/state"
  "DELIVERY_LOCK_FILE=$SCRATCH/delivery.lock"
  "TAILDROP_TARGET=darknight:"
  "DELIVERY_RETRY_DELAY_SECONDS=0"
  "ALERT_WEBHOOK_CONFIG=$SCRATCH/alert-webhook.curl"
  "FAKE_TAILSCALE_LOG=$SCRATCH/tailscale.log"
  "FAKE_ALERT_LOG=$SCRATCH/alerts.log"
)

env "${DELIVERY_ENV[@]}" FAKE_FAIL_UNTIL=2 "$ROOT/scripts/deliver-off-host.sh" >/dev/null
[ "$(wc -l < "$SCRATCH/tailscale.log")" -eq 3 ]
[ ! -e "$SCRATCH/alerts.log" ]
[ "$(stat -c '%a' "$SCRATCH/state/delivery.state")" = '600' ]
grep -q '^status=healthy$' "$SCRATCH/state/delivery.state"
grep -Eq '^delivered_sha256=[a-f0-9]{64}$' "$SCRATCH/state/delivery.state"

env "${DELIVERY_ENV[@]}" "$ROOT/scripts/deliver-off-host.sh" > "$SCRATCH/duplicate.out"
[ "$(wc -l < "$SCRATCH/tailscale.log")" -eq 3 ]
grep -q 'already delivered' "$SCRATCH/duplicate.out"

printf '%s\n' 'new-encrypted-test-payload' > "$BACKUP"
(cd "$SCRATCH/backups" && sha256sum "$(basename "$BACKUP")" > "$(basename "$BACKUP").sha256")
if env "${DELIVERY_ENV[@]}" FAKE_FAIL_UNTIL=99 "$ROOT/scripts/deliver-off-host.sh" >/dev/null 2>&1; then
  echo 'FAIL  exhausted delivery unexpectedly passed' >&2
  exit 1
fi
[ "$(grep -c 'OFF-HOST DELIVERY FAILED' "$SCRATCH/alerts.log")" -eq 1 ]
grep -q '^status=unhealthy$' "$SCRATCH/state/delivery.state"
grep -q '^failure_alerted=1$' "$SCRATCH/state/delivery.state"

if env "${DELIVERY_ENV[@]}" FAKE_FAIL_UNTIL=99 "$ROOT/scripts/deliver-off-host.sh" >/dev/null 2>&1; then
  echo 'FAIL  repeated exhausted delivery unexpectedly passed' >&2
  exit 1
fi
[ "$(grep -c 'OFF-HOST DELIVERY FAILED' "$SCRATCH/alerts.log")" -eq 1 ]

env "${DELIVERY_ENV[@]}" "$ROOT/scripts/deliver-off-host.sh" >/dev/null
[ "$(grep -c 'OFF-HOST DELIVERY RECOVERED' "$SCRATCH/alerts.log")" -eq 1 ]
grep -q '^status=healthy$' "$SCRATCH/state/delivery.state"
grep -q '^recovery_alert_pending=0$' "$SCRATCH/state/delivery.state"
echo 'PASS  off-host retry, state, duplicate suppression, alert, and recovery integration'
