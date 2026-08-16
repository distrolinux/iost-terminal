#!/bin/bash
# deploy-host.sh — launch IOST Terminal as a docker service on this Hostinger VPS
# with Traefik TLS for iostcallister.com. Run as root on the HOST:
#   bash /docker/hermes-agent-ghfx/data/iost-terminal/deploy-host.sh
set -u
STACK=/docker/hermes-agent-ghfx
APP=$STACK/data/iost-terminal
echo "==> app dir: $APP"
[ -d "$APP" ] || { echo "ERROR: $APP not found"; exit 1; }

# network: the one the existing stack is on (traefik lives there too)
NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(docker ps -q | head -1)" 2>/dev/null | awk '{print $1}')
[ -n "$NET" ] || { echo "ERROR: could not detect network"; exit 1; }
echo "==> network: $NET"

echo "==> traefik container + args (for entrypoint/certresolver names):"
TF=$(docker ps -q --filter name=traefik | head -1)
if [ -n "$TF" ]; then
  echo "    traefik: $(docker inspect -f '{{.Name}}' "$TF")"
  docker inspect -f '{{range .Args}}{{println .}}{{end}}' "$TF" | grep -E 'entrypoint|certresolver|providers' || echo "    (no matching args found)"
else
  echo "    WARNING: no container named traefik — labels may not route"
fi

echo "==> removing any previous iost-terminal container..."
docker rm -f iost-terminal > /dev/null 2>&1 || true

echo "==> starting iost-terminal (node:20, restart unless-stopped, runs as data-owner uid)..."
docker run -d --name iost-terminal --restart unless-stopped \
  --network "$NET" \
  --user "$(stat -c '%u:%g' "$APP")" \
  -v "$APP:/app" -w /app \
  --label traefik.enable=true \
  --label "traefik.http.routers.iost.rule=Host(\`iostcallister.com\`) || Host(\`www.iostcallister.com\`)" \
  --label traefik.http.routers.iost.entrypoints=websecure \
  --label traefik.http.routers.iost.tls.certresolver=letsencrypt \
  --label traefik.http.services.iost.loadbalancer.server.port=8787 \
  node:20 node server.js

echo "==> status:"
sleep 4
docker ps --filter name=iost-terminal --format '    {{.Names}}  {{.Status}}'
echo "==> logs:"
docker logs --tail 6 iost-terminal
echo "==> local check through the app:"
curl -s -o /dev/null -w '    http://iost-terminal:8787 -> %{http_code}\n' http://iost-terminal:8787/api/health || echo "    (in-container check skipped)"
echo "DONE — paste this full output back to the agent."
