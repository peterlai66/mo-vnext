#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ $# -eq 0 ]]; then
	echo "mo-project: 缺少 commit message，已中止。" >&2
	echo "用法: npm run commit -- \"type: 說明\"" >&2
	exit 1
fi

MSG="$*"
git add .
git commit -m "$MSG"
