#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

mkdir -p "$REPO_ROOT/dist"

echo "[build] Building linux-x64..."
bun build "$REPO_ROOT/packages/agent/service.ts" \
  --compile \
  --target=bun-linux-x64 \
  --outfile="$REPO_ROOT/dist/majordomo-linux-x64"

echo "[build] Building darwin-arm64..."
bun build "$REPO_ROOT/packages/agent/service.ts" \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile="$REPO_ROOT/dist/majordomo-darwin-arm64"

echo "[build] Done. Binaries in dist/"
ls -lh "$REPO_ROOT/dist/"
