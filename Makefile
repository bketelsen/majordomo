# Majordomo Makefile
# Usage: make <target>

.PHONY: help install bootstrap dev service test typecheck lint \
        setup deploy rollback start stop restart status logs \
        build build-linux build-darwin \
        clean clean-dist git-push

# ── Defaults ──────────────────────────────────────────────────────────────────

SHELL := /bin/bash
BUN   := bun

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
		| sort

# ── Development ───────────────────────────────────────────────────────────────

install: ## Install dependencies
	$(BUN) install

bootstrap: ## Initialize COG memory structure in ~/.majordomo
	$(BUN) packages/agent/scripts/bootstrap.ts

dev: ## Run service from source (no deploy)
	$(BUN) packages/agent/service.ts

service: dev ## Alias for dev

agent: ## Run interactive agent (terminal)
	$(BUN) packages/agent/main.ts

# ── Testing ───────────────────────────────────────────────────────────────────

test: ## Run test suite
	$(BUN) test packages/agent/tests/

test-watch: ## Run tests in watch mode
	$(BUN) test --watch packages/agent/tests/

typecheck: ## Type-check TypeScript
	cd packages/agent && $(BUN) x tsc --noEmit

lint: ## Lint shell scripts with shellcheck
	@command -v shellcheck >/dev/null 2>&1 || { echo "shellcheck not installed"; exit 1; }
	shellcheck bin/majordomo bin/deploy.sh bin/setup.sh bin/build-executables.sh

check: typecheck test ## Run typecheck + tests

# ── Deployment (via bin/majordomo CLI) ────────────────────────────────────────

setup: ## First-time setup (~/.majordomo + systemd)
	bash bin/setup.sh

deploy: ## Build and deploy to ~/.local/share/majordomo
	bash bin/deploy.sh

rollback: ## Rollback to previous deployment
	~/.local/bin/majordomo rollback

start: ## Start majordomo service
	~/.local/bin/majordomo start

stop: ## Stop majordomo service
	~/.local/bin/majordomo stop

restart: ## Restart majordomo service
	~/.local/bin/majordomo restart

status: ## Show service status
	~/.local/bin/majordomo status

logs: ## Tail service logs
	~/.local/bin/majordomo logs

# ── Build (bun --compile) ─────────────────────────────────────────────────────

build: ## Build binaries for all platforms
	bash bin/build-executables.sh

build-linux: ## Build linux-x64 binary only
	$(BUN) build packages/agent/service.ts \
		--compile --target=bun-linux-x64 \
		--outfile=dist/majordomo-linux-x64

build-darwin: ## Build darwin-arm64 binary only
	$(BUN) build packages/agent/service.ts \
		--compile --target=bun-darwin-arm64 \
		--outfile=dist/majordomo-darwin-arm64

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts
	rm -rf dist/

clean-all: clean ## Remove build artifacts + node_modules
	rm -rf node_modules packages/*/node_modules

# ── Git ───────────────────────────────────────────────────────────────────────

push: ## Push to GitHub (uses gh auth token for HTTPS)
	@git remote set-url origin "https://$$(gh auth token)@github.com/bketelsen/majordomo.git"
	git push
	@git remote set-url origin https://github.com/bketelsen/majordomo.git
