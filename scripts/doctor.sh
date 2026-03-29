#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ok=true

echo "=== mo-project doctor ==="
echo "ROOT: $ROOT"
echo ""

if [[ -d "$ROOT/.git" ]]; then
	echo "[ok] .git 存在（git 根目錄）"
else
	echo "[!!] 未找到 $ROOT/.git（請在 mo-project 初始化 git：git init）"
	ok=false
fi

if [[ -f "$ROOT/mo-backend/package.json" ]]; then
	echo "[ok] mo-backend/package.json 存在"
else
	echo "[!!] 缺少 mo-backend/package.json"
	ok=false
fi

if [[ -f "$ROOT/mo-web/package.json" ]]; then
	echo "[ok] mo-web/package.json 存在"
else
	echo "[!!] 缺少 mo-web/package.json"
	ok=false
fi

if [[ -f "$ROOT/package.json" ]]; then
	echo "[ok] root package.json 存在"
else
	echo "[!!] 缺少 root package.json"
	ok=false
fi

echo ""
if [[ "$ok" == true ]]; then
	echo "doctor: 通過"
	exit 0
fi
echo "doctor: 未通過"
exit 1
