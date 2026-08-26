#!/bin/bash
# Deliver the newest encrypted backup and checksum through Taildrop. This script
# never decrypts data, starts/restarts containers, deploys, trades, or changes
# token/chain state.
set -Eeuo pipefail
umask 077

STACK="${STACK:-/docker/hermes-agent-ghfx}"
BACKUP_DIR="${BACKUP_DIR:-$STACK/backups/iost-terminal}"
DELIVERY_STATE_DIR="${DELIVERY_STATE_DIR:-$STACK/monitoring/iost-terminal/off-host-delivery}"
DELIVERY_LOCK_FILE="${DELIVERY_LOCK_FILE:-/var/lock/iost-terminal-off-host-delivery.lock}"
DELIVERY_MAX_ATTEMPTS="${DELIVERY_MAX_ATTEMPTS:-3}"
DELIVERY_RETRY_DELAY_SECONDS="${DELIVERY_RETRY_DELAY_SECONDS:-5}"
TAILDROP_TARGET="${TAILDROP_TARGET:-}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"
ALERT_WEBHOOK_CONFIG="${ALERT_WEBHOOK_CONFIG:-}"
STATE_FILE="$DELIVERY_STATE_DIR/delivery.state"

fail() { echo "ERROR: $*" >&2; exit 1; }
json_escape() { sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\n/\\n/g' <<<"$1"; }
tailscale_cmd() { "$TAILSCALE_BIN" "$@"; }
send_alert() {
  local message="$1"
  echo "$message" >&2
  if [ -n "$ALERT_WEBHOOK_CONFIG" ]; then
    if ! curl --fail --silent --show-error --max-time 10 \
      -H 'content-type: application/json' \
      --data "{\"text\":\"$(json_escape "$message")\"}" \
      --config "$ALERT_WEBHOOK_CONFIG" >/dev/null; then
      echo 'ERROR: off-host delivery alert could not be sent' >&2
      return 1
    fi
  fi
}
write_state() {
  local status="$1" delivered_sha="$2" pending_sha="$3" backup_name="$4"
  local failure_alerted="$5" recovery_alert_pending="$6"
  local tmp="$STATE_FILE.tmp.$$"
  {
    echo "status=$status"
    echo "delivered_sha256=$delivered_sha"
    echo "pending_sha256=$pending_sha"
    echo "backup_name=$backup_name"
    echo "failure_alerted=$failure_alerted"
    echo "recovery_alert_pending=$recovery_alert_pending"
    echo "updated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

command -v flock >/dev/null || fail 'flock is required'
command -v sha256sum >/dev/null || fail 'sha256sum is required'
command -v "$TAILSCALE_BIN" >/dev/null || fail 'tailscale is required'
[[ "$DELIVERY_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail 'DELIVERY_MAX_ATTEMPTS must be positive'
(( DELIVERY_MAX_ATTEMPTS <= 10 )) || fail 'DELIVERY_MAX_ATTEMPTS must not exceed 10'
[[ "$DELIVERY_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail 'DELIVERY_RETRY_DELAY_SECONDS must be non-negative'
(( DELIVERY_RETRY_DELAY_SECONDS <= 300 )) || fail 'DELIVERY_RETRY_DELAY_SECONDS must not exceed 300'
[ -d "$BACKUP_DIR" ] || fail 'backup directory does not exist'
[ -n "$TAILDROP_TARGET" ] || fail 'TAILDROP_TARGET is required'
[[ "$TAILDROP_TARGET" == *: ]] || fail 'TAILDROP_TARGET must end with a colon'
[[ "$TAILDROP_TARGET" != -* && ! "$TAILDROP_TARGET" =~ [[:space:]] ]] || fail 'TAILDROP_TARGET is invalid'
if [ -n "$ALERT_WEBHOOK_CONFIG" ]; then
  command -v curl >/dev/null || fail 'curl is required when alerting is configured'
  [ -f "$ALERT_WEBHOOK_CONFIG" ] || fail 'ALERT_WEBHOOK_CONFIG does not exist'
  webhook_mode="$(stat -c '%a' "$ALERT_WEBHOOK_CONFIG")"
  (( (8#$webhook_mode & 077) == 0 )) || fail 'ALERT_WEBHOOK_CONFIG must not be accessible by group or other users'
fi

mkdir -p "$(dirname "$DELIVERY_LOCK_FILE")" "$DELIVERY_STATE_DIR"
chmod 700 "$DELIVERY_STATE_DIR"
exec 9>"$DELIVERY_LOCK_FILE"
flock -n 9 || exit 0

previous_status='healthy'
delivered_sha=''
failure_alerted=0
recovery_alert_pending=0
if [ -f "$STATE_FILE" ]; then
  chmod 600 "$STATE_FILE"
  previous_status="$(sed -n 's/^status=//p' "$STATE_FILE" | head -1)"
  delivered_sha="$(sed -n 's/^delivered_sha256=//p' "$STATE_FILE" | head -1)"
  failure_alerted="$(sed -n 's/^failure_alerted=//p' "$STATE_FILE" | head -1)"
  recovery_alert_pending="$(sed -n 's/^recovery_alert_pending=//p' "$STATE_FILE" | head -1)"
  [[ "$previous_status" =~ ^(healthy|unhealthy)$ ]] || previous_status='healthy'
  [[ -z "$delivered_sha" || "$delivered_sha" =~ ^[a-f0-9]{64}$ ]] || delivered_sha=''
  [[ "$failure_alerted" =~ ^[01]$ ]] || failure_alerted=0
  [[ "$recovery_alert_pending" =~ ^[01]$ ]] || recovery_alert_pending=0
fi

latest_backup="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'iost-terminal-backup-*.tar.gz.gpg' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[ -n "$latest_backup" ] || fail 'no encrypted production backup was found'
checksum_file="$latest_backup.sha256"
[ -f "$checksum_file" ] || fail 'encrypted backup checksum sidecar is missing'
[ ! -L "$latest_backup" ] && [ ! -L "$checksum_file" ] || fail 'backup artifacts must not be symbolic links'
read -r expected_sha recorded_name extra < "$checksum_file" || fail 'encrypted backup checksum sidecar is invalid'
recorded_name="${recorded_name#\*}"
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ && "$recorded_name" = "$(basename "$latest_backup")" && -z "${extra:-}" ]] \
  || fail 'encrypted backup checksum sidecar is invalid'
(
  cd "$BACKUP_DIR"
  sha256sum -c "$(basename "$checksum_file")" >/dev/null
) || fail 'encrypted backup checksum verification failed'

current_sha="$(sha256sum "$latest_backup" | awk '{print $1}')"
[[ "$current_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'encrypted backup SHA-256 is invalid'
backup_name="$(basename "$latest_backup")"
if [ "$current_sha" = "$delivered_sha" ]; then
  if [ "$recovery_alert_pending" -eq 1 ]; then
    if send_alert "IOST Terminal OFF-HOST DELIVERY RECOVERED — encrypted backup delivery resumed."; then
      write_state healthy "$current_sha" '' "$backup_name" 0 0
    fi
  fi
  echo "OK — encrypted backup already delivered: $backup_name"
  exit 0
fi

attempt=1
while (( attempt <= DELIVERY_MAX_ATTEMPTS )); do
  if tailscale_cmd file cp -- "$latest_backup" "$checksum_file" "$TAILDROP_TARGET" >/dev/null 2>&1; then
    if [ "$previous_status" = 'unhealthy' ]; then
      if send_alert "IOST Terminal OFF-HOST DELIVERY RECOVERED — encrypted backup delivery resumed."; then
        recovery_alert_pending=0
      else
        recovery_alert_pending=1
      fi
    fi
    write_state healthy "$current_sha" '' "$backup_name" 0 "$recovery_alert_pending"
    echo "DONE — encrypted backup queued for off-host delivery: $backup_name"
    exit 0
  fi
  if (( attempt < DELIVERY_MAX_ATTEMPTS )); then
    delay=$(( DELIVERY_RETRY_DELAY_SECONDS * (2 ** (attempt - 1)) ))
    (( delay > 0 )) && sleep "$delay"
  fi
  attempt=$((attempt + 1))
done

if [ "$previous_status" != 'unhealthy' ] || [ "$failure_alerted" -ne 1 ]; then
  if send_alert "IOST Terminal OFF-HOST DELIVERY FAILED — encrypted backup was not delivered after ${DELIVERY_MAX_ATTEMPTS} attempts."; then
    failure_alerted=1
  else
    failure_alerted=0
  fi
fi
write_state unhealthy "$delivered_sha" "$current_sha" "$backup_name" "$failure_alerted" 0
echo "ERROR: off-host delivery failed after $DELIVERY_MAX_ATTEMPTS attempts" >&2
exit 1
