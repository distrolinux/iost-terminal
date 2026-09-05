#!/bin/bash
# Health-checked, single-writer deployment for the Hostinger Docker host.
# Builds one immutable image, validates it against scratch data, then performs
# a short production handoff with automatic container rollback on failure.
set -Eeuo pipefail
umask 077

usage() { echo "Usage: bash deploy-host.sh [--preflight-only]"; }
PREFLIGHT_ONLY="${PREFLIGHT_ONLY:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done
case "$PREFLIGHT_ONLY" in
  0|1) ;;
  *) echo "ERROR: PREFLIGHT_ONLY must be 0 or 1"; exit 2 ;;
esac

STACK="${STACK:-/docker/hermes-agent-ghfx}"
APP="${APP:-$STACK/data/iost-terminal}"
DATA_DIR="${DATA_DIR:-$APP/data}"
PROD_CONTAINER="${PROD_CONTAINER:-iost-terminal}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://iostcallister.com/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
LOCK_FILE="${LOCK_FILE:-/var/lock/iost-terminal-deploy.lock}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CANDIDATE="${PROD_CONTAINER}-candidate-${TIMESTAMP}"
ROLLBACK_CONTAINER=""
OLD_PRESENT=0
PROMOTION_STARTED=0
DEPLOY_SUCCEEDED=0
ENV_SNAPSHOT=""

docker_cmd() { docker "$@"; }
container_exists() { docker_cmd inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$(docker_cmd inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }
network_for_container() {
  docker_cmd inspect -f '{{range $name,$settings := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$1" 2>/dev/null | sed -n '1p'
}

wait_for_health() {
  local container="$1" deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if container_running "$container" && docker_cmd exec "$container" node -e \
      "fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{const b=await r.json();if(!r.ok||b.ok!==true||b.revision!==process.env.APP_REVISION)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  echo "ERROR: $container did not become healthy within ${HEALTH_TIMEOUT}s"
  docker_cmd logs --tail 40 "$container" 2>/dev/null || true
  return 1
}

wait_for_public_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if docker_cmd exec "$PROD_CONTAINER" node -e \
      "const [url,expected]=process.argv.slice(1);fetch(url,{signal:AbortSignal.timeout(5000)}).then(async r=>{const b=await r.json();if(!r.ok||b.ok!==true||b.revision!==expected)process.exit(1)}).catch(()=>process.exit(1))" \
      "$PUBLIC_HEALTH_URL" "$REVISION" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  echo "ERROR: public health check failed: $PUBLIC_HEALTH_URL"
  return 1
}

rollback_production() {
  echo "==> promotion failed; restoring the previous production container..."
  if [ -n "$ROLLBACK_CONTAINER" ] && container_exists "$ROLLBACK_CONTAINER"; then
    docker_cmd rm -f "$PROD_CONTAINER" >/dev/null 2>&1 || true
    docker_cmd rename "$ROLLBACK_CONTAINER" "$PROD_CONTAINER"
    if [ "$(docker_cmd inspect -f '{{.State.Paused}}' "$PROD_CONTAINER")" = "true" ]; then
      docker_cmd unpause "$PROD_CONTAINER" >/dev/null
    else
      docker_cmd start "$PROD_CONTAINER" >/dev/null
    fi
    wait_for_health "$PROD_CONTAINER"
    echo "==> rollback healthy"
    return 0
  fi
  if [ "$OLD_PRESENT" -eq 1 ] && container_exists "$PROD_CONTAINER"; then
    if [ "$(docker_cmd inspect -f '{{.State.Paused}}' "$PROD_CONTAINER")" = "true" ]; then
      docker_cmd unpause "$PROD_CONTAINER" >/dev/null 2>&1 || true
    else
      docker_cmd start "$PROD_CONTAINER" >/dev/null 2>&1 || true
    fi
    wait_for_health "$PROD_CONTAINER"
    echo "==> previous container remained available and is healthy"
    return 0
  fi
  docker_cmd rm -f "$PROD_CONTAINER" >/dev/null 2>&1 || true
  echo "ERROR: no previous container was available for rollback"
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  docker_cmd rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ "$PROMOTION_STARTED" -eq 1 ] && [ "$DEPLOY_SUCCEEDED" -eq 0 ]; then
    rollback_production || true
  fi
  if [ -n "$ENV_SNAPSHOT" ]; then rm -f "$ENV_SNAPSHOT"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null || { echo "ERROR: docker is required"; exit 1; }
command -v flock >/dev/null || { echo "ERROR: flock is required"; exit 1; }

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "ERROR: another IOST Terminal deployment is already running"; exit 1; }

echo "==> app dir: $APP"
[ -d "$APP" ] || { echo "ERROR: $APP not found"; exit 1; }
[ -f "$APP/Dockerfile" ] || { echo "ERROR: $APP/Dockerfile not found"; exit 1; }
mkdir -p "$DATA_DIR"

if ! git -C "$APP" diff --quiet || ! git -C "$APP" diff --cached --quiet || \
   [ -n "$(git -C "$APP" ls-files --others --exclude-standard)" ]; then
  echo "ERROR: refusing to deploy a dirty or untracked working tree"
  exit 1
fi
REVISION="$(git -C "$APP" rev-parse --verify HEAD)"
IOST_IMAGE="iost-terminal:${REVISION:0:12}"

if container_exists "$PROD_CONTAINER"; then OLD_PRESENT=1; fi

# Docker network-only containers do not bind this host port; a listener here
# indicates a duplicate process unless the production container owns it.
if command -v ss >/dev/null && ss -H -ltn 'sport = :8787' 2>/dev/null | grep -q .; then
  if [ "$OLD_PRESENT" -eq 0 ] || ! docker_cmd port "$PROD_CONTAINER" 8787/tcp 2>/dev/null | grep -q .; then
    echo "ERROR: unmanaged host listener detected on port 8787; remove the stale process first"
    exit 1
  fi
fi

PRIOR_ROLLBACKS=('')
RELATED_CONTAINERS=('')
while IFS= read -r related; do
  RELATED_CONTAINERS+=("$related")
done < <(docker_cmd ps --format '{{.Names}}' | awk -v prod="$PROD_CONTAINER" '$0 ~ ("^" prod) && $0 != prod')
for related in "${RELATED_CONTAINERS[@]}"; do
  [ -n "$related" ] || continue
  if [[ "$related" == "${PROD_CONTAINER}-rollback-"* ]] && \
     [ "$(docker_cmd inspect -f '{{.State.Paused}}' "$related")" = "true" ]; then
    PRIOR_ROLLBACKS+=("$related")
  else
    echo "ERROR: unexpected additional IOST Terminal container is running: $related"
    exit 1
  fi
done

if [ -n "${DOCKER_NETWORK:-}" ]; then
  NET="$DOCKER_NETWORK"
elif [ "$OLD_PRESENT" -eq 1 ]; then
  NET="$(network_for_container "$PROD_CONTAINER")"
else
  TRAEFIK="$(docker_cmd ps -q --filter name=traefik | sed -n '1p')"
  [ -n "$TRAEFIK" ] || { echo "ERROR: no production container or Traefik network found"; exit 1; }
  NET="$(network_for_container "$TRAEFIK")"
fi
[ -n "$NET" ] || { echo "ERROR: could not determine the deployment network"; exit 1; }
echo "==> network: $NET"

ENV_ARGS=()
if [ -n "${ENV_FILE:-}" ]; then
  [ -f "$ENV_FILE" ] || { echo "ERROR: ENV_FILE does not exist"; exit 1; }
  ENV_ARGS=(--env-file "$ENV_FILE")
elif [ "$OLD_PRESENT" -eq 1 ]; then
  ENV_SNAPSHOT="$(mktemp /tmp/iost-terminal-env.XXXXXX)"
  docker_cmd inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PROD_CONTAINER" > "$ENV_SNAPSHOT"
  chmod 600 "$ENV_SNAPSHOT"
  ENV_ARGS=(--env-file "$ENV_SNAPSHOT")
elif [ -f "$APP/.env" ]; then
  ENV_ARGS=(--env-file "$APP/.env")
fi

APP_UID="$(stat -c '%u' "$APP")"
APP_GID="$(stat -c '%g' "$APP")"

echo "==> building immutable image: $IOST_IMAGE"
docker_cmd build --pull \
  --label "com.iost-terminal.revision=$REVISION" \
  --label "com.iost-terminal.built-at=$TIMESTAMP" \
  -t "$IOST_IMAGE" -f "$APP/Dockerfile" "$APP"

start_candidate() {
  echo "==> starting isolated candidate (scratch data, live credentials disabled)..."
  docker_cmd run -d --name "$CANDIDATE" --restart no \
    --network "$NET" --user "$APP_UID:$APP_GID" \
    "${ENV_ARGS[@]}" \
    -e APP_REVISION="$REVISION" \
    -e KRAKEN_API_KEY= -e KRAKEN_API_SECRET= -e IOST_PIN_KEY= \
    --tmpfs "/app/data:rw,noexec,nosuid,nodev,size=64m,mode=1770,uid=$APP_UID,gid=$APP_GID" \
    "$IOST_IMAGE" >/dev/null
}

start_candidate
wait_for_health "$CANDIDATE"
echo "==> candidate healthy; production has not been touched"
docker_cmd rm -f "$CANDIDATE" >/dev/null

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  echo "DONE — preflight only; production was not paused, replaced, or modified."
  exit 0
fi

# Retain exactly one last-known-good process. An older paused rollback is only
# retired after the new candidate has proven healthy and while current
# production is still serving traffic.
for prior in "${PRIOR_ROLLBACKS[@]}"; do
  [ -n "$prior" ] || continue
  echo "==> retiring superseded paused rollback: $prior"
  docker_cmd rm -f "$prior" >/dev/null
done

PROMOTION_STARTED=1
if [ "$OLD_PRESENT" -eq 1 ]; then
  ROLLBACK_CONTAINER="${PROD_CONTAINER}-rollback-${TIMESTAMP}"
  echo "==> pausing the previous writer for promotion..."
  docker_cmd pause "$PROD_CONTAINER" >/dev/null
  docker_cmd rename "$PROD_CONTAINER" "$ROLLBACK_CONTAINER"
fi

# Legacy containers may have written stores as root.  Migrate ownership only
# after the previous writer is paused so it cannot immediately recreate
# root-owned files.  The retained rollback container runs as root and remains
# able to read these files if promotion fails.
echo "==> aligning production data ownership for the non-root runtime..."
chown -R "$APP_UID:$APP_GID" "$DATA_DIR"

echo "==> starting production from $IOST_IMAGE..."
docker_cmd run -d --name "$PROD_CONTAINER" --restart unless-stopped \
  --network "$NET" --user "$APP_UID:$APP_GID" \
  "${ENV_ARGS[@]}" \
  -e APP_REVISION="$REVISION" \
  -v "$DATA_DIR:/app/data" \
  --label com.iost-terminal.production=true \
  --label "com.iost-terminal.revision=$REVISION" \
  --label traefik.enable=true \
  --label "traefik.http.routers.iost.rule=Host(\`iostcallister.com\`) || Host(\`www.iostcallister.com\`)" \
  --label traefik.http.routers.iost.entrypoints=websecure \
  --label traefik.http.routers.iost.tls.certresolver=letsencrypt \
  --label traefik.http.services.iost.loadbalancer.server.port=8787 \
  "$IOST_IMAGE" >/dev/null

wait_for_health "$PROD_CONTAINER" || { echo "ERROR: promotion failed internal health"; exit 1; }
wait_for_public_health || { echo "ERROR: promotion failed public health"; exit 1; }
DEPLOY_SUCCEEDED=1

echo "==> deployment healthy"
docker_cmd ps --filter "name=^/${PROD_CONTAINER}$" --format '    {{.Names}}  {{.Image}}  {{.Status}}'
if [ -n "$ROLLBACK_CONTAINER" ]; then
  echo "==> paused last-known-good rollback retained: $ROLLBACK_CONTAINER"
fi
echo "DONE — no live order or public-chain action was performed."
