#!/usr/bin/env bash
# Build the Docker image on the server (no registry needed) and restart the
# walbi-exchange-proxy container. Assumes:
#   - server compose file at /root/server/docker-compose.shared.yml has the
#     walbi-exchange-proxy service (from docker-compose.fragment.yml here)
#   - /root/secrets/walbi-exchange-proxy.env exists with WALBI_MCP_URL etc.

set -euo pipefail

HOST="root@46.224.164.185"
REMOTE_DIR="/root/walbi-exchange-proxy"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ Syncing source to $HOST:$REMOTE_DIR…"
rsync -avz --delete \
  --exclude node_modules --exclude dist --exclude .git \
  "$HERE/" "$HOST:$REMOTE_DIR/"

echo "▸ Building Docker image on the server…"
ssh "$HOST" "cd $REMOTE_DIR && docker build -t walbi-exchange-proxy:dev ."

echo "▸ Recreating container…"
ssh "$HOST" "cd /root/server && docker compose -f docker-compose.shared.yml -f docker-compose.prod.yml up -d walbi-exchange-proxy"

echo "▸ Health check…"
sleep 3
ssh "$HOST" "docker exec walbi-exchange-proxy wget -qO- http://localhost:3002/healthz || true"

echo "✓ Deployed."
