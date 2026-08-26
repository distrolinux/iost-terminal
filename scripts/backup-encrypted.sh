#!/bin/bash
# Consistent, encrypted production-data backup. This script never starts,
# replaces, or deploys the application container.
set -Eeuo pipefail
umask 077

STACK="${STACK:-/docker/hermes-agent-ghfx}"
APP="${APP:-$STACK/data/iost-terminal}"
DATA_DIR="${DATA_DIR:-$APP/data}"
PROD_CONTAINER="${PROD_CONTAINER:-iost-terminal}"
BACKUP_DIR="${BACKUP_DIR:-$STACK/backups/iost-terminal}"
BACKUP_MIRROR_DIR="${BACKUP_MIRROR_DIR:-}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
GPG_BIN="${GPG_BIN:-gpg}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
LOCK_FILE="${LOCK_FILE:-/var/lock/iost-terminal-backup.lock}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_NAME="iost-terminal-backup-$TIMESTAMP"
WORK_DIR=""
WAS_PAUSED=0

docker_cmd() { docker "$@"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$WAS_PAUSED" -eq 1 ]; then
    docker_cmd unpause "$PROD_CONTAINER" >/dev/null 2>&1 || {
      echo "CRITICAL: could not unpause $PROD_CONTAINER after backup" >&2
      status=1
    }
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then rm -rf -- "$WORK_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null || fail 'docker is required'
command -v "$GPG_BIN" >/dev/null || fail 'gpg is required'
command -v flock >/dev/null || fail 'flock is required'
command -v sha256sum >/dev/null || fail 'sha256sum is required'
command -v tar >/dev/null || fail 'tar is required'
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail 'RETENTION_DAYS must be a non-negative integer'
[ -d "$DATA_DIR" ] || fail "data directory does not exist: $DATA_DIR"
[ -n "$BACKUP_PASSPHRASE_FILE" ] || fail 'BACKUP_PASSPHRASE_FILE is required'
[ -f "$BACKUP_PASSPHRASE_FILE" ] || fail 'backup passphrase file does not exist'

pass_mode="$(stat -c '%a' "$BACKUP_PASSPHRASE_FILE")"
(( (8#$pass_mode & 077) == 0 )) || fail 'backup passphrase file must not be accessible by group or other users'
[ -s "$BACKUP_PASSPHRASE_FILE" ] || fail 'backup passphrase file is empty'

mkdir -p "$(dirname "$LOCK_FILE")" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another IOST Terminal backup is already running'

running="$(docker_cmd inspect -f '{{.State.Running}}' "$PROD_CONTAINER" 2>/dev/null || true)"
[ "$running" = 'true' ] || fail 'production container is not running; refusing to snapshot uncertain state'
paused="$(docker_cmd inspect -f '{{.State.Paused}}' "$PROD_CONTAINER" 2>/dev/null || true)"
[ "$paused" = 'false' ] || fail 'production container is already paused'
revision="$(docker_cmd inspect -f '{{index .Config.Labels "com.iost-terminal.revision"}}' "$PROD_CONTAINER" 2>/dev/null || true)"
[ -n "$revision" ] || fail 'production container has no revision label'

WORK_DIR="$(mktemp -d "$BACKUP_DIR/.backup-work.XXXXXX")"
SNAPSHOT_ROOT="$WORK_DIR/$SNAPSHOT_NAME"
mkdir -p "$SNAPSHOT_ROOT/data"

echo "==> pausing the sole production writer for a consistent snapshot"
docker_cmd pause "$PROD_CONTAINER" >/dev/null
WAS_PAUSED=1
cp -a "$DATA_DIR/." "$SNAPSHOT_ROOT/data/"
docker_cmd unpause "$PROD_CONTAINER" >/dev/null
WAS_PAUSED=0
echo "==> production writer resumed"

if find "$SNAPSHOT_ROOT/data" -type l -print -quit | grep -q .; then
  fail 'snapshot contains a symbolic link'
fi
if find "$SNAPSHOT_ROOT/data" ! -type f ! -type d -print -quit | grep -q .; then
  fail 'snapshot contains a special file'
fi
find "$SNAPSHOT_ROOT/data" -type d -exec chmod 700 {} +
find "$SNAPSHOT_ROOT/data" -type f -exec chmod 600 {} +

{
  echo 'format=1'
  echo "created_utc=$TIMESTAMP"
  echo "revision=$revision"
  echo 'payload=data'
} > "$SNAPSHOT_ROOT/METADATA"
(
  cd "$SNAPSHOT_ROOT"
  find data -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum > SHA256SUMS
)

ARCHIVE="$WORK_DIR/$SNAPSHOT_NAME.tar.gz"
ENCRYPTED_PART="$BACKUP_DIR/.$SNAPSHOT_NAME.tar.gz.gpg.partial"
ENCRYPTED_FINAL="$BACKUP_DIR/$SNAPSHOT_NAME.tar.gz.gpg"
CHECKSUM_FINAL="$ENCRYPTED_FINAL.sha256"
tar -C "$WORK_DIR" -czf "$ARCHIVE" "$SNAPSHOT_NAME"
"$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache \
  --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 \
  --compress-algo none --output "$ENCRYPTED_PART" "$ARCHIVE"
chmod 600 "$ENCRYPTED_PART"
mv "$ENCRYPTED_PART" "$ENCRYPTED_FINAL"
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$ENCRYPTED_FINAL")" > "$(basename "$CHECKSUM_FINAL")"
)
chmod 600 "$CHECKSUM_FINAL"

if [ -n "$BACKUP_MIRROR_DIR" ]; then
  [ "$BACKUP_MIRROR_DIR" != "$BACKUP_DIR" ] || fail 'BACKUP_MIRROR_DIR must differ from BACKUP_DIR'
  mkdir -p "$BACKUP_MIRROR_DIR"
  chmod 700 "$BACKUP_MIRROR_DIR"
  mirror_backup="$BACKUP_MIRROR_DIR/$(basename "$ENCRYPTED_FINAL")"
  mirror_checksum="$BACKUP_MIRROR_DIR/$(basename "$CHECKSUM_FINAL")"
  cp -p "$ENCRYPTED_FINAL" "$mirror_backup.partial"
  cp -p "$CHECKSUM_FINAL" "$mirror_checksum.partial"
  mv "$mirror_backup.partial" "$mirror_backup"
  mv "$mirror_checksum.partial" "$mirror_checksum"
  (cd "$BACKUP_MIRROR_DIR" && sha256sum -c "$(basename "$CHECKSUM_FINAL")" >/dev/null)
fi

while IFS= read -r -d '' expired; do
  rm -f -- "$expired" "$expired.sha256"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'iost-terminal-backup-*.tar.gz.gpg' -mtime "+$RETENTION_DAYS" -print0)

echo "DONE — encrypted backup created: $ENCRYPTED_FINAL"
echo "      revision: $revision"
echo '      no live order, token, conversion, staking, liquidity, or chain action was performed.'
