#!/bin/bash
set -e
cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[engram]${NC} $1"; }
ok()   { echo -e "${GREEN}[engram]${NC} $1"; }
err()  { echo -e "${RED}[engram]${NC} $1"; }

if ! docker compose -p engram ps -q 2>/dev/null | grep -q .; then
  ok "No engram containers running."
  exit 0
fi

log "Stopping engram containers..."
docker compose -p engram down --remove-orphans
ok "All engram containers stopped."
