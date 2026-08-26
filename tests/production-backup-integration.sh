#!/bin/bash
# Offline integration check using a fake Docker observer and real GnuPG.
set -Eeuo pipefail
umask 077

if ! command -v gpg >/dev/null || ! command -v tar >/dev/null; then
  echo 'SKIP  production backup integration (gpg or tar unavailable)'
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/iost-ops-test.XXXXXX")"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$SCRATCH/app/data/nested" "$SCRATCH/bin" "$SCRATCH/gnupg"
chmod 700 "$SCRATCH/gnupg"
printf '%s\n' '{"account":"paper-only","balance":10000}' > "$SCRATCH/app/data/accounts.json"
printf '%s\n' 'audit-entry' > "$SCRATCH/app/data/nested/audit.jsonl"
printf '%s\n' 'integration-test-passphrase-that-is-not-a-production-secret' > "$SCRATCH/passphrase"
chmod 600 "$SCRATCH/passphrase"

printf '%s\n' \
  '#!/bin/bash' \
  'set -eu' \
  'case "$1" in' \
  '  inspect)' \
  '    case "$3" in' \
  '      *State.Running*) echo true ;;' \
  '      *State.Paused*) echo false ;;' \
  '      *State.Health.Status*) echo "${FAKE_HEALTH:-healthy}" ;;' \
  '      *com.iost-terminal.revision*) echo 57e1853ac95a2c01101fb0df8fc1c8e5547f97ed ;;' \
  '      *) exit 1 ;;' \
  '    esac ;;' \
  '  pause|unpause) exit 0 ;;' \
  '  *) exit 1 ;;' \
  'esac' > "$SCRATCH/bin/docker"
chmod 700 "$SCRATCH/bin/docker"

# Some restricted CI sandboxes deny the gpg-agent socket even though GnuPG
# completes loopback symmetric encryption/decryption. This wrapper accepts that
# one sandbox-only exit when a non-empty output was produced; payload comparison
# below still proves that the real GnuPG round trip succeeded. Production never
# sets GPG_BIN and therefore uses GnuPG's unmodified exit status.
printf '%s\n' \
  '#!/bin/bash' \
  'set +e' \
  'output=' \
  'expect_output=0' \
  'for arg in "$@"; do' \
  '  if [ "$expect_output" -eq 1 ]; then output="$arg"; expect_output=0; continue; fi' \
  '  [ "$arg" = "--output" ] && expect_output=1' \
  'done' \
  'message="$(/usr/bin/gpg "$@" 2>&1)"' \
  'status=$?' \
  'if [ "$status" -ne 0 ] && [ -n "$output" ] && [ -s "$output" ] && grep -q "No agent running" <<<"$message"; then exit 0; fi' \
  'printf "%s\\n" "$message" >&2' \
  'exit "$status"' > "$SCRATCH/bin/gpg-sandbox"
chmod 700 "$SCRATCH/bin/gpg-sandbox"

printf '%s\n' \
  '#!/bin/bash' \
  'set -eu' \
  'if [[ " $* " = *" --config "* ]]; then printf "%s\\n" "$*" >> "$FAKE_ALERT_LOG"; exit 0; fi' \
  'printf "%s\\n" "{\"ok\":true,\"revision\":\"57e1853ac95a2c01101fb0df8fc1c8e5547f97ed\"}"' \
  > "$SCRATCH/bin/curl"
printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s\\n" "Filesystem 1024-blocks Used Available Capacity Mounted on"' \
  'printf "%s\\n" "/dev/fake 100000 10000 90000 10% /data"' \
  > "$SCRATCH/bin/df"
chmod 700 "$SCRATCH/bin/curl" "$SCRATCH/bin/df"
printf '%s\n' 'url = "https://alerts.invalid/hook"' > "$SCRATCH/alert-webhook.curl"
chmod 600 "$SCRATCH/alert-webhook.curl"

env \
  PATH="$SCRATCH/bin:$PATH" GNUPGHOME="$SCRATCH/gnupg" GPG_BIN="$SCRATCH/bin/gpg-sandbox" \
  STACK="$SCRATCH" APP="$SCRATCH/app" DATA_DIR="$SCRATCH/app/data" \
  BACKUP_DIR="$SCRATCH/backups" BACKUP_MIRROR_DIR="$SCRATCH/mirror" \
  BACKUP_PASSPHRASE_FILE="$SCRATCH/passphrase" LOCK_FILE="$SCRATCH/backup.lock" \
  "$ROOT/scripts/backup-encrypted.sh" >/dev/null

BACKUP="$(find "$SCRATCH/backups" -maxdepth 1 -name 'iost-terminal-backup-*.tar.gz.gpg' -type f -print -quit)"
[ -n "$BACKUP" ]
[ -f "$BACKUP.sha256" ]
[ -f "$SCRATCH/mirror/$(basename "$BACKUP")" ]
[ -f "$SCRATCH/mirror/$(basename "$BACKUP").sha256" ]

env GNUPGHOME="$SCRATCH/gnupg" GPG_BIN="$SCRATCH/bin/gpg-sandbox" BACKUP_PASSPHRASE_FILE="$SCRATCH/passphrase" \
  "$ROOT/scripts/verify-backup-restore.sh" "$BACKUP" >/dev/null
env GNUPGHOME="$SCRATCH/gnupg" GPG_BIN="$SCRATCH/bin/gpg-sandbox" BACKUP_PASSPHRASE_FILE="$SCRATCH/passphrase" \
  "$ROOT/scripts/restore-encrypted-backup.sh" "$BACKUP" "$SCRATCH/restored" >/dev/null

cmp "$SCRATCH/app/data/accounts.json" "$SCRATCH/restored/accounts.json"
cmp "$SCRATCH/app/data/nested/audit.jsonl" "$SCRATCH/restored/nested/audit.jsonl"
[ "$(stat -c '%a' "$SCRATCH/restored/accounts.json")" = '600' ]
[ "$(stat -c '%a' "$SCRATCH/restored/nested")" = '700' ]
echo 'PASS  encrypted backup and isolated restore integration'

MONITOR_ENV=(
  "PATH=$SCRATCH/bin:$PATH"
  "STACK=$SCRATCH"
  "APP=$SCRATCH/app"
  "DATA_DIR=$SCRATCH/app/data"
  "BACKUP_DIR=$SCRATCH/backups"
  "MONITOR_STATE_DIR=$SCRATCH/monitor"
  "LOCK_FILE=$SCRATCH/monitor.lock"
  "ALERT_WEBHOOK_CONFIG=$SCRATCH/alert-webhook.curl"
  "FAKE_ALERT_LOG=$SCRATCH/alerts"
)

env "${MONITOR_ENV[@]}" "$ROOT/scripts/monitor-production.sh" >/dev/null
for attempt in 1 2 3 4; do
  if env "${MONITOR_ENV[@]}" FAKE_HEALTH=unhealthy "$ROOT/scripts/monitor-production.sh" >/dev/null 2>&1; then
    echo 'FAIL  unhealthy monitor run unexpectedly passed' >&2
    exit 1
  fi
done
[ "$(wc -l < "$SCRATCH/alerts")" -eq 1 ]
grep -q 'IOST Terminal ALERT' "$SCRATCH/alerts"
env "${MONITOR_ENV[@]}" "$ROOT/scripts/monitor-production.sh" >/dev/null
[ "$(wc -l < "$SCRATCH/alerts")" -eq 2 ]
grep -q 'IOST Terminal RECOVERED' "$SCRATCH/alerts"
echo 'PASS  monitor threshold, incident deduplication, and recovery integration'
