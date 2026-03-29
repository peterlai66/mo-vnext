#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "=== mo-project status ==="
echo "ROOT: $ROOT"
echo ""

if [[ -d .git ]]; then
	echo "--- git branch ---"
	git branch --show-current 2>/dev/null || true
	echo ""
	echo "--- git status (short) ---"
	git status -sb
	echo ""
	echo "--- working tree (porcelain) ---"
	if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
		echo "(clean，無未提交變更)"
	else
		git status --porcelain
	fi
else
	echo "(此目錄尚未初始化 git)"
fi

echo ""
echo "--- 子專案 ---"
[[ -d mo-backend ]] && echo "mo-backend: 存在" || echo "mo-backend: 缺少"
[[ -d mo-web ]] && echo "mo-web: 存在" || echo "mo-web: 缺少"
