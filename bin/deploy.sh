#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Build and deploy Majordomo
#
# What it does:
# 1. Validates source repository
# 2. Installs dependencies (bun install)
# 3. Rotates current → previous
# 4. Copies artifacts to current/
# 5. Writes VERSION file from git describe

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

MAJORDOMO_HOME="${MAJORDOMO_HOME:-$HOME/.local/share/majordomo}"
MAJORDOMO_STATE="${MAJORDOMO_STATE:-$HOME/.majordomo}"

# Resolve bun — handle non-interactive shells where ~/.bun/bin isn't on PATH
if ! command -v bun &>/dev/null; then
  [[ -x "$HOME/.bun/bin/bun" ]] && export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun &>/dev/null || die "bun not found — install from https://bun.sh"

log()  { echo "[deploy] $*"; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── Preflight checks ──────────────────────────────────────────────────────────

[[ -f "$REPO_ROOT/package.json" ]] || die "Not in majordomo repo (package.json not found)"
[[ -d "$MAJORDOMO_STATE/memory" ]] || die "Memory not initialized. Run: majordomo setup"

cd "$REPO_ROOT"

# ── Install dependencies ──────────────────────────────────────────────────────

log "Installing dependencies..."
bun install --frozen-lockfile || die "bun install failed"

# ── Version tag ───────────────────────────────────────────────────────────────

VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev-$(date +%Y%m%d-%H%M%S)")
log "Version: $VERSION"

# ── Rotate deployments ────────────────────────────────────────────────────────

mkdir -p "$MAJORDOMO_HOME"

if [[ -d "$MAJORDOMO_HOME/current" ]]; then
  log "Rotating current → previous"
  rm -rf "$MAJORDOMO_HOME/previous"
  mv "$MAJORDOMO_HOME/current" "$MAJORDOMO_HOME/previous"
fi

mkdir -p "$MAJORDOMO_HOME/current"

# ── Copy artifacts ────────────────────────────────────────────────────────────

log "Copying artifacts to $MAJORDOMO_HOME/current..."

# Core packages (Bun runs TypeScript directly, so copy source)
cp -r "$REPO_ROOT/packages" "$MAJORDOMO_HOME/current/packages"

# Dependencies
cp -r "$REPO_ROOT/node_modules" "$MAJORDOMO_HOME/current/node_modules"

# Package manifests
cp "$REPO_ROOT/package.json" "$MAJORDOMO_HOME/current/package.json"
[[ -f "$REPO_ROOT/bun.lockb" ]] && cp "$REPO_ROOT/bun.lockb" "$MAJORDOMO_HOME/current/bun.lockb"

# Default agents and workflows (fallback templates)
cp -r "$REPO_ROOT/agents" "$MAJORDOMO_HOME/current/agents"
cp -r "$REPO_ROOT/workflows" "$MAJORDOMO_HOME/current/workflows"

# Optional: .env.example for reference
[[ -f "$REPO_ROOT/.env.example" ]] && cp "$REPO_ROOT/.env.example" "$MAJORDOMO_HOME/current/.env.example"

# Version marker
echo "$VERSION" > "$MAJORDOMO_HOME/current/VERSION"

log "✓ Deployed v$VERSION to $MAJORDOMO_HOME/current"

echo ""
echo "Next steps:"
echo "  1. Restart service:  systemctl --user restart majordomo"
echo "     (or)              majordomo restart"
echo "  2. Check status:     majordomo status"
echo "  3. View logs:        majordomo logs"
echo ""
echo "To rollback:           majordomo rollback"
