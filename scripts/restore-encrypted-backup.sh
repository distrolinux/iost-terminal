#!/bin/bash
# Decrypt and verify one backup into an empty target. Production restore is
# fail-closed and requires an explicit override plus a stopped container.
set -Eeuo pipefail
umask 077

STACK="${STACK:-/docker/hermes-agent-ghfx}"
APP="${APP:-$STACK/data/iost-terminal}"
PRODUCTION_DATA_DIR="${PRODUCTION_DATA_DIR:-$APP/data}"
PROD_CONTAINER="${PROD_CONTAINER:-iost-terminal}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
GPG_BIN="${GPG_BIN:-gpg}"
BACKUP_FILE="${1:-}"
RESTORE_TARGET="${2:-}"
WORK_DIR=""

fail() { echo "ERROR: $*" >&2; exit 1; }
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then rm -rf -- "$WORK_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v "$GPG_BIN" >/dev/null || fail 'gpg is required'
command -v sha256sum >/dev/null || fail 'sha256sum is required'
command -v tar >/dev/null || fail 'tar is required'
command -v readlink >/dev/null || fail 'readlink is required'
[ -n "$BACKUP_FILE" ] || fail 'usage: restore-encrypted-backup.sh BACKUP_FILE EMPTY_TARGET'
[ -f "$BACKUP_FILE" ] || fail 'backup file does not exist'
[ -n "$RESTORE_TARGET" ] || fail 'restore target is required'
[ -n "$BACKUP_PASSPHRASE_FILE" ] || fail 'BACKUP_PASSPHRASE_FILE is required'
[ -f "$BACKUP_PASSPHRASE_FILE" ] || fail 'backup passphrase file does not exist'
pass_mode="$(stat -c '%a' "$BACKUP_PASSPHRASE_FILE")"
(( (8#$pass_mode & 077) == 0 )) || fail 'backup passphrase file must not be accessible by group or other users'

target_real="$(readlink -m "$RESTORE_TARGET")"
production_real="$(readlink -m "$PRODUCTION_DATA_DIR")"
[ "$target_real" != '/' ] || fail 'refusing to restore to filesystem root'
[ "$target_real" != "$(readlink -m "$APP")" ] || fail 'refusing to restore over the application directory'

if [ "$target_real" = "$production_real" ]; then
  [ "${ALLOW_PRODUCTION_RESTORE:-NO}" = 'YES' ] || fail 'production restore requires ALLOW_PRODUCTION_RESTORE=YES'
  if command -v docker >/dev/null && [ "$(docker inspect -f '{{.State.Running}}' "$PROD_CONTAINER" 2>/dev/null || true)" = 'true' ]; then
    fail 'production container must be stopped before production restore'
  fi
fi

if [ -e "$target_real" ] && [ -n "$(find "$target_real" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  fail 'restore target must be empty; existing data is never overwritten'
fi

CHECKSUM_FILE="$BACKUP_FILE.sha256"
[ -f "$CHECKSUM_FILE" ] || fail 'encrypted backup checksum sidecar is missing'
(
  cd "$(dirname "$BACKUP_FILE")"
  sha256sum -c "$(basename "$CHECKSUM_FILE")" >/dev/null
) || fail 'encrypted backup checksum verification failed'

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/iost-terminal-restore.XXXXXX")"
ARCHIVE="$WORK_DIR/backup.tar.gz"
EXTRACTED="$WORK_DIR/extracted"
mkdir -p "$EXTRACTED"
"$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache \
  --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt --output "$ARCHIVE" "$BACKUP_FILE"

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..) fail "unsafe archive path: $entry" ;;
  esac
done < <(tar -tzf "$ARCHIVE")
tar -C "$EXTRACTED" -xzf "$ARCHIVE" --no-same-owner --no-same-permissions

mapfile -t roots < <(find "$EXTRACTED" -mindepth 1 -maxdepth 1 -type d -print)
[ "${#roots[@]}" -eq 1 ] || fail 'backup must contain exactly one root directory'
SNAPSHOT_ROOT="${roots[0]}"
[ -f "$SNAPSHOT_ROOT/METADATA" ] || fail 'backup metadata is missing'
[ -f "$SNAPSHOT_ROOT/SHA256SUMS" ] || fail 'backup payload manifest is missing'
[ -d "$SNAPSHOT_ROOT/data" ] || fail 'backup data payload is missing'

if find "$SNAPSHOT_ROOT/data" -type l -print -quit | grep -q .; then
  fail 'restored payload contains a symbolic link'
fi
if find "$SNAPSHOT_ROOT/data" ! -type f ! -type d -print -quit | grep -q .; then
  fail 'restored payload contains a special file'
fi
(cd "$SNAPSHOT_ROOT" && sha256sum -c SHA256SUMS >/dev/null) || fail 'backup payload hash verification failed'

mkdir -p "$target_real"
chmod 700 "$target_real"
cp -a "$SNAPSHOT_ROOT/data/." "$target_real/"
find "$target_real" -type d -exec chmod 700 {} +
find "$target_real" -type f -exec chmod 600 {} +

revision="$(sed -n 's/^revision=//p' "$SNAPSHOT_ROOT/METADATA")"
echo "DONE — verified restore created at: $target_real"
echo "      backup revision: ${revision:-unknown}"
