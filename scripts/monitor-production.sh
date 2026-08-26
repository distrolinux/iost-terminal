#!/bin/bash
# One-shot production monitor for cron/systemd. It observes and alerts only;
# it never restarts, deploys, trades, or changes chain/token state.
set -Eeuo pipefail
umask 077

STACK="${STACK:-/docker/hermes-agent-ghfx}"
APP="${APP:-$STACK/data/iost-terminal}"
DATA_DIR="${DATA_DIR:-$APP/data}"
PROD_CONTAINER="${PROD_CONTAINER:-iost-terminal}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://iostcallister.com/api/health}"
BACKUP_DIR="${BACKUP_DIR:-$STACK/backups/iost-terminal}"
MONITOR_STATE_DIR="${MONITOR_STATE_DIR:-$STACK/monitoring/iost-terminal}"
ALERT_WEBHOOK_CONFIG="${ALERT_WEBHOOK_CONFIG:-}"
ALERT_AFTER_FAILURES="${ALERT_AFTER_FAILURES:-3}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-85}"
LOCK_FILE="${LOCK_FILE:-/var/lock/iost-terminal-monitor.lock}"
STATE_FILE="$MONITOR_STATE_DIR/state"
failures=()

fail() { echo "ERROR: $*" >&2; exit 1; }
add_failure() { failures+=("$1"); }
json_escape() { sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\n/\\n/g' <<<"$1"; }
send_alert() {
  local message="$1"
  echo "$message" >&2
  if [ -n "$ALERT_WEBHOOK_CONFIG" ]; then
    curl --fail --silent --show-error --max-time 10 \
      -H 'content-type: application/json' \
      --data "{\"text\":\"$(json_escape "$message")\"}" \
      --config "$ALERT_WEBHOOK_CONFIG" >/dev/null
  fi
}
write_state() {
  local count="$1" status="$2" tmp="$STATE_FILE.tmp.$$"
  {
    echo "failure_count=$count"
    echo "status=$status"
    echo "updated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

command -v docker >/dev/null || fail 'docker is required'
command -v curl >/dev/null || fail 'curl is required'
command -v flock >/dev/null || fail 'flock is required'
[[ "$ALERT_AFTER_FAILURES" =~ ^[1-9][0-9]*$ ]] || fail 'ALERT_AFTER_FAILURES must be positive'
[[ "$BACKUP_MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] || fail 'BACKUP_MAX_AGE_HOURS must be positive'
[[ "$DISK_MAX_PERCENT" =~ ^[1-9][0-9]*$ ]] || fail 'DISK_MAX_PERCENT must be positive'
if [ -n "$ALERT_WEBHOOK_CONFIG" ]; then
  [ -f "$ALERT_WEBHOOK_CONFIG" ] || fail 'ALERT_WEBHOOK_CONFIG does not exist'
  webhook_mode="$(stat -c '%a' "$ALERT_WEBHOOK_CONFIG")"
  (( (8#$webhook_mode & 077) == 0 )) || fail 'ALERT_WEBHOOK_CONFIG must not be accessible by group or other users'
fi

mkdir -p "$(dirname "$LOCK_FILE")" "$MONITOR_STATE_DIR"
chmod 700 "$MONITOR_STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

previous_count=0
previous_status='healthy'
if [ -f "$STATE_FILE" ]; then
  previous_count="$(sed -n 's/^failure_count=//p' "$STATE_FILE")"
  previous_status="$(sed -n 's/^status=//p' "$STATE_FILE")"
  [[ "$previous_count" =~ ^[0-9]+$ ]] || previous_count=0
  [[ "$previous_status" =~ ^(healthy|unhealthy)$ ]] || previous_status='healthy'
fi

running="$(docker inspect -f '{{.State.Running}}' "$PROD_CONTAINER" 2>/dev/null || true)"
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$PROD_CONTAINER" 2>/dev/null || true)"
revision="$(docker inspect -f '{{index .Config.Labels "com.iost-terminal.revision"}}' "$PROD_CONTAINER" 2>/dev/null || true)"
[ "$running" = 'true' ] || add_failure 'production container is not running'
[ "$health" = 'healthy' ] || add_failure "container health is ${health:-unavailable}"
[ -n "$revision" ] || add_failure 'container revision label is missing'

response_file="$(mktemp "${TMPDIR:-/tmp}/iost-terminal-health.XXXXXX")"
trap 'rm -f -- "$response_file"' EXIT INT TERM
if ! curl --fail --silent --show-error --max-time 10 "$PUBLIC_HEALTH_URL" > "$response_file"; then
  add_failure 'public health endpoint is unreachable'
else
  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$response_file" || add_failure 'public health did not report ok=true'
  public_revision="$(sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$response_file" | head -1)"
  if [ -n "$revision" ] && [ "$public_revision" != "$revision" ]; then
    add_failure "public health revision does not match expected revision $revision"
  fi
fi

disk_percent="$(df -P "$DATA_DIR" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [[ "$disk_percent" =~ ^[0-9]+$ ]]; then
  (( disk_percent <= DISK_MAX_PERCENT )) || add_failure "data filesystem usage is ${disk_percent}%"
else
  add_failure 'data filesystem usage is unavailable'
fi

latest_backup="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'iost-terminal-backup-*.tar.gz.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$latest_backup" ]; then
  add_failure 'no encrypted production backup was found'
else
  backup_epoch="$(stat -c '%Y' "$latest_backup")"
  backup_age_hours=$(( ($(date +%s) - backup_epoch) / 3600 ))
  (( backup_age_hours <= BACKUP_MAX_AGE_HOURS )) || add_failure "latest encrypted backup is ${backup_age_hours}h old"
  [ -f "$latest_backup.sha256" ] || add_failure 'latest encrypted backup checksum sidecar is missing'
fi

if [ "${#failures[@]}" -eq 0 ]; then
  write_state 0 healthy
  if [ "$previous_status" = 'unhealthy' ]; then
    send_alert "IOST Terminal RECOVERED — container, public revision, disk, and backup checks are healthy."
  fi
  echo "OK — production revision $revision is healthy"
  exit 0
fi

current_count=$((previous_count + 1))
summary="$(IFS='; '; echo "${failures[*]}")"
if (( current_count >= ALERT_AFTER_FAILURES )) && [ "$previous_status" != 'unhealthy' ]; then
  send_alert "IOST Terminal ALERT — $summary"
  write_state "$current_count" unhealthy
else
  write_state "$current_count" "$previous_status"
fi
echo "UNHEALTHY ($current_count/$ALERT_AFTER_FAILURES) — $summary" >&2
exit 1
