#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCREEN_NAME="startpage-proxy"

if screen -list | grep -q "\.${SCREEN_NAME}\b"; then
  echo "Screen session '${SCREEN_NAME}' already running."
  echo "Attach with: screen -r ${SCREEN_NAME}"
  exit 0
fi

screen -S "${SCREEN_NAME}" -dm bash -lc "if [ -s \"\$HOME/.nvm/nvm.sh\" ]; then . \"\$HOME/.nvm/nvm.sh\"; fi; cd '${SCRIPT_DIR}' && npm start"
echo "Started '${SCREEN_NAME}'. Attach with: screen -r ${SCREEN_NAME}"
