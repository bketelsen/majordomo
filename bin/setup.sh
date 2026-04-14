#!/usr/bin/env bash
set -euo pipefail

# setup.sh — First-time Majordomo installation
#
# What it does:
# 1. Creates ~/.majordomo/{memory,data,config,logs} structure
# 2. Migrates existing memory/data from project root if present
# 3. Copies default agents/workflows to config
# 4. Bootstraps COG memory structure
# 5. Creates .env template if needed
# 6. Installs CLI symlink to ~/.local/bin/majordomo
# 7. Performs initial deployment
# 8. Installs systemd user unit

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

MAJORDOMO_STATE="${MAJORDOMO_STATE:-$HOME/.majordomo}"
MAJORDOMO_HOME="${MAJORDOMO_HOME:-$HOME/.local/share/majordomo}"

log() { echo "[setup] $*"; }
warn() { echo "[setup] WARNING: $*" >&2; }
die() { echo "[setup] ERROR: $*" >&2; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║         Majordomo First-Time Setup                    ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# ── Create state home structure ──────────────────────────────────────────────

log "Creating state directories at $MAJORDOMO_STATE..."
mkdir -p "$MAJORDOMO_STATE"/{memory,data,config,logs}
mkdir -p "$MAJORDOMO_STATE/data"/{sessions,scratch,widgets}
mkdir -p "$MAJORDOMO_STATE/config"/{agents,workflows}

# ── Migrate existing data if present ─────────────────────────────────────────

if [[ -d "$REPO_ROOT/memory" && -n "$(ls -A "$REPO_ROOT/memory" 2>/dev/null)" ]]; then
  log "Found existing memory/ in project root — migrating..."
  cp -rn "$REPO_ROOT/memory/"* "$MAJORDOMO_STATE/memory/" 2>/dev/null || true
  log "✓ Memory migrated (originals left in place)"
fi

if [[ -d "$REPO_ROOT/data" && -n "$(ls -A "$REPO_ROOT/data" 2>/dev/null)" ]]; then
  log "Found existing data/ in project root — migrating..."
  cp -rn "$REPO_ROOT/data/"* "$MAJORDOMO_STATE/data/" 2>/dev/null || true
  log "✓ Data migrated (originals left in place)"
fi

# ── Copy default configurations ──────────────────────────────────────────────

log "Copying default agent and workflow configurations..."
if [[ -d "$REPO_ROOT/agents" ]]; then
  cp -rn "$REPO_ROOT/agents/"* "$MAJORDOMO_STATE/config/agents/" 2>/dev/null || true
fi

if [[ -d "$REPO_ROOT/workflows" ]]; then
  cp -rn "$REPO_ROOT/workflows/"* "$MAJORDOMO_STATE/config/workflows/" 2>/dev/null || true
fi

# ── Bootstrap COG memory ──────────────────────────────────────────────────────

if [[ ! -f "$MAJORDOMO_STATE/memory/domains.yml" ]]; then
  log "Bootstrapping COG memory structure..."
  cd "$REPO_ROOT"
  if [[ -f "packages/agent/scripts/bootstrap.ts" ]]; then
    MAJORDOMO_STATE="$MAJORDOMO_STATE" bun packages/agent/scripts/bootstrap.ts
    log "✓ COG memory initialized"
  else
    warn "Bootstrap script not found — you may need to initialize memory manually"
  fi
else
  log "COG memory already initialized (domains.yml exists)"
fi

# ── Create .env template ──────────────────────────────────────────────────────

if [[ ! -f "$MAJORDOMO_STATE/.env" ]]; then
  log "Creating .env template..."
  
  if [[ -f "$REPO_ROOT/.env.example" ]]; then
    cp "$REPO_ROOT/.env.example" "$MAJORDOMO_STATE/.env"
  else
    # Create minimal .env
    cat > "$MAJORDOMO_STATE/.env" <<'EOF'
# Majordomo Configuration
# Edit this file with your credentials

# Port for web dashboard
PORT=3000

# Telegram integration (optional)
#TELEGRAM_BOT_TOKEN=your_token_here

# AI Provider (Anthropic or OpenAI)
ANTHROPIC_API_KEY=your_key_here
#OPENAI_API_KEY=your_key_here

# pi-agent-core settings
PI_MODEL=claude-3-5-sonnet-20241022
PI_PROVIDER=anthropic

# Logging
#LOG_LEVEL=info
EOF
  fi
  
  log "✓ Created $MAJORDOMO_STATE/.env"
  warn "IMPORTANT: Edit $MAJORDOMO_STATE/.env with your API keys!"
else
  log ".env already exists"
fi

# ── Install CLI symlink ───────────────────────────────────────────────────────

log "Installing CLI..."
mkdir -p "$HOME/.local/bin"

if [[ -L "$HOME/.local/bin/majordomo" ]]; then
  log "CLI symlink already exists"
else
  ln -sf "$REPO_ROOT/bin/majordomo" "$HOME/.local/bin/majordomo"
  log "✓ Installed majordomo CLI to ~/.local/bin/majordomo"
fi

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "~/.local/bin is not in your PATH"
  echo ""
  echo "  Add this to your ~/.bashrc or ~/.zshrc:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

# ── Initial deployment ────────────────────────────────────────────────────────

log "Performing initial deployment..."
bash "$SCRIPT_DIR/deploy.sh" || die "Initial deployment failed"

# ── Install systemd unit ──────────────────────────────────────────────────────

if [[ -f "$REPO_ROOT/systemd/majordomo.service" ]]; then
  log "Installing systemd user unit..."
  mkdir -p "$HOME/.config/systemd/user"
  
  # Replace placeholders in template
  sed "s|%h|$HOME|g" \
    "$REPO_ROOT/systemd/majordomo.service" \
    > "$HOME/.config/systemd/user/majordomo.service"
  
  systemctl --user daemon-reload
  
  log "✓ Systemd unit installed"
else
  warn "systemd/majordomo.service not found — skipping systemd installation"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║         Setup Complete!                                ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit configuration:"
echo "       vi $MAJORDOMO_STATE/.env"
echo ""
echo "  2. Enable and start the service:"
echo "       systemctl --user enable majordomo"
echo "       systemctl --user start majordomo"
echo ""
echo "  3. Check status:"
echo "       majordomo status"
echo "       systemctl --user status majordomo"
echo ""
echo "  4. View logs:"
echo "       majordomo logs"
echo "       journalctl --user -u majordomo -f"
echo ""
echo "Paths:"
echo "  Deploy:  $MAJORDOMO_HOME"
echo "  State:   $MAJORDOMO_STATE"
echo "  Logs:    $MAJORDOMO_STATE/logs/majordomo.log"
echo ""
