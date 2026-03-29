#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ $# -eq 0 ]]; then
	echo "mo-project: 缺少 commit message，已中止。" >&2
	echo "用法: npm run ship:backend -- \"type: 說明\"" >&2
	exit 1
fi

if [[ ! -d .git ]]; then
	echo "mo-project: 找不到 .git，無法提交。" >&2
	exit 1
fi

MSG="$*"
echo "=== ship:backend（root git add/commit/push → mo-backend deploy）==="
git add .
git commit -m "$MSG"
git push
bash "$SCRIPT_DIR/deploy-backend.sh"
