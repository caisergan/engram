#!/bin/bash
set -e
cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[engram]${NC} $1"; }
ok()   { echo -e "${GREEN}[engram]${NC} $1"; }
warn() { echo -e "${YELLOW}[engram]${NC} $1"; }
err()  { echo -e "${RED}[engram]${NC} $1"; }

# Ensure .env exists
if [ ! -f .env ]; then
  err ".env file not found in docker/"
  warn "Copy docker/.env.example to docker/.env and fill in the required values."
  exit 1
fi

HOST_PORT=$(grep -E '^HOST_PORT=' .env | cut -d= -f2 | tr -d '"' || true)
HOST_PORT="${HOST_PORT:-3030}"

# Compute a hash of everything that would change the built image:
# committed state + any uncommitted diffs (covers both clean and dirty trees)
get_source_hash() {
  local commit
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "no-git")
  local dirty
  dirty=$(git -C "$REPO_ROOT" diff HEAD 2>/dev/null | sha256sum | cut -d' ' -f1)
  echo "${commit}-${dirty}"
}

HASH_FILE=".last-build-hash"
CURRENT_HASH=$(get_source_hash)
STORED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")
IMAGE_EXISTS=$(docker image inspect engram:local >/dev/null 2>&1 && echo "yes" || echo "no")

# Decide whether a rebuild is needed
NEED_BUILD=false
if [ "$IMAGE_EXISTS" = "no" ]; then
  log "No image found — building for the first time..."
  NEED_BUILD=true
elif [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
  log "Changes detected since last build — rebuilding..."
  NEED_BUILD=true
else
  log "No changes since last build — reusing existing image."
fi

# Stop any running containers for this project
if docker compose -p engram ps -q 2>/dev/null | grep -q .; then
  log "Stopping existing engram containers..."
  docker compose -p engram down --remove-orphans
  ok "Stopped."
fi

if [ "$NEED_BUILD" = "true" ]; then
  # BuildKit enables the pnpm store cache mount in the Dockerfile
  export DOCKER_BUILDKIT=1
  export COMPOSE_DOCKER_CLI_BUILD=1
  log "Building image (pnpm packages cached across builds)..."
  docker compose -p engram build
  echo "$CURRENT_HASH" > "$HASH_FILE"
  ok "Build complete."
fi

# Start all services
log "Starting services..."
docker compose -p engram up -d

# Wait for web container to become healthy
log "Waiting for web to be ready..."
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Status}}' engram-web-1 2>/dev/null || true)
  if [ "$STATUS" = "running" ]; then
    HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HOST_PORT}/" 2>/dev/null || true)
    if [ "$HTTP" = "200" ] || [ "$HTTP" = "307" ] || [ "$HTTP" = "302" ]; then
      ok "Engram is up at http://localhost:${HOST_PORT}"
      echo ""
      docker compose -p engram ps
      echo ""
      log "Logs: docker compose -p engram logs -f"
      exit 0
    fi
  fi
  sleep 2
done

warn "Container started but health check timed out. Check logs:"
warn "  docker compose -p engram logs -f web"
docker compose -p engram ps
