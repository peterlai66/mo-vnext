#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== deploy:all（先 backend，再 web）==="
bash "$SCRIPT_DIR/deploy-backend.sh"
bash "$SCRIPT_DIR/deploy-web.sh"
