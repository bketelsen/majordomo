# Majordomo

Personal AI chief-of-staff with domain-aware memory, subagent orchestration, and multi-interface access (web, Telegram, CLI).

Built on [`pi-agent-core`](https://github.com/badlogic/pi-mono) with [COG memory protocol](https://github.com/marciopuga/cog).

---

## Architecture

**Single long-running session** with domain-aware context switching.

- **Domain** = isolated context layer with dedicated memory, conversation history, and tools
- **State home** (`~/.majordomo/`) = memory, sessions, databases, configuration
- **Deploy home** (`~/.local/share/majordomo/`) = compiled artifacts, systemd working directory
- **Source** (`~/projects/sionapi/`) = Git repository

---

## Prerequisites

- **Bun** runtime
- **Pi coding agent** ([installation](https://github.com/badlogic/pi-mono))
- **LLM access**: GitHub Copilot subscription (recommended) or Anthropic/OpenAI API key

---

## Quick start

```bash
# 1. Clone
git clone <repo> ~/projects/sionapi
cd ~/projects/sionapi

# 2. Setup (creates state dirs, installs dependencies, builds)
bash bin/setup.sh

# 3. Configure
vi ~/.majordomo/.env
# Add TELEGRAM_BOT_TOKEN (optional), API keys (if not using Copilot)

# 4. Authenticate with LLM (if using GitHub Copilot)
pi   # → /login → GitHub Copilot

# 5. Start service
majordomo start

# Web dashboard: http://localhost:3000
```

---

## Usage modes

| Command | Use case |
|---------|----------|
| `majordomo start` | Production daemon (systemd-managed) |
| `majordomo dev` | Development mode (runs from source) |
| `bun packages/agent/main.ts` | Interactive CLI (single domain) |

---

## Domain switching

Domains isolate context — each has its own memory, conversation history, and dashboard tab.

**Switch domains:**
- Natural language: _"Switch to my work domain"_
- Command: `/switch work`
- Web UI: Click domain tab

**Built-in domains:**
- `general` — default cross-domain context
- `cog-meta` — Majordomo self-improvement

**Create domain:**
> _"Create a domain for my homelab projects"_

This scaffolds `~/.majordomo/memory/homelab/` with COG structure.

---

## Memory system (COG)

See **[USINGCOG.md](USINGCOG.md)** for the full reference. Canonical spec: https://lab.puga.com.br/cog/

All LLM context is built from `~/.majordomo/memory/` using the COG retrieval protocol:

```
memory/
  domains.yml              # Domain registry
  hot-memory.md            # Cross-domain facts (<50 lines)
  cog-meta/
    patterns.md            # Interaction patterns (always injected)
    foresight-nudge.md     # Daily strategic nudge
  {domain}/
    hot-memory.md          # Domain-specific context
    action-items.md        # Tasks
    observations.md        # Timestamped events
    entities.md            # People & organizations
  glacier/                 # Archived searchable data
```

**Majordomo memory tools:**
- `cog_l0_scan` — list available files
- `cog_l1_scan` — scan section headers
- `cog_read` — read file or section
- `cog_write` — write with validation
- `cog_append_observation` — timestamped event logging
- `cog_update_action_item` — task management
- `cog_glacier_search` — search archived memory
- `cog_wiki_follow` — traverse `[[wiki-links]]`

---

## Subagents & workflows

Spawn specialist agents for complex work:

```
"Research Postgres vs SQLite performance for this workload"
→ spawns researcher agent
→ notifies when complete

"Run research-to-implementation for adding OAuth"
→ researcher → architect → developer → qa (pipeline)
```

**Agent definitions:** `~/.majordomo/config/agents/*.md` (fallback: built-in agents)  
**Workflow definitions:** `~/.majordomo/config/workflows/*.yaml`

Built-in agents: `researcher`, `architect`, `developer`, `qa`  
Built-in workflow: `research-to-implementation`

---

## Web dashboard

**URL:** http://localhost:3000

**Panels:**
- 🔥 Active priorities (`action-items.md`)
- 🐋 Containers (Docker + Incus)
- ⚙ Subagent runs
- ⏰ Scheduled jobs
- 📬 Recent email (IMAP, optional)
- 📂 Domain switcher

All panels are live-updated via SSE.

---

## Telegram (optional)

1. Create bot via [@BotFather](https://t.me/BotFather)
2. Add `TELEGRAM_BOT_TOKEN` to `~/.majordomo/.env`
3. Start service, send message to bot
4. Each domain becomes a separate Telegram conversation

---

## Scheduled pipeline

COG maintenance runs automatically:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `/cog-foresight` | Daily 07:00 | Strategic nudge generation |
| `/cog-reflect` | Sun 02:00 | Condense observations → patterns |
| `/cog-housekeeping` | Sun 03:00 | Archive stale data, rebuild indexes |
| `/cog-evolve` | Sun 04:00 | Architecture audit |

Trigger manually: `/cog-housekeeping`, `/cog-reflect`, etc.

Register custom jobs:
> _"Schedule daily standup at 9am in work domain"_

---

## Service management

```bash
# Production
majordomo start                  # Enable + start systemd service
majordomo stop                   # Stop service
majordomo restart                # Restart
majordomo status                 # Show version, PID, paths
majordomo logs                   # Tail application logs

# Deploy new version
cd ~/projects/sionapi
git pull
majordomo deploy                 # Build + rotate artifacts
majordomo restart

# Rollback
majordomo rollback               # Swap current ↔ previous
majordomo restart

# Development
majordomo dev                    # Run from source (no deployment)
```

---

## Directory layout

```
~/projects/sionapi/                        # Source (Git)
├── packages/
│   ├── agent/                             # Core agent + extensions
│   │   ├── extensions/
│   │   │   ├── cog-memory/                # COG tools
│   │   │   ├── domain-manager/            # Domain lifecycle
│   │   │   ├── subagent-manager/          # Orchestration
│   │   │   └── scheduler/                 # Cron jobs
│   │   ├── lib/
│   │   │   ├── domain-context-manager.ts  # Single-session architecture
│   │   │   └── telegram-bot.ts            # Telegram routing
│   │   ├── persona/majordomo.md           # Chief-of-staff persona
│   │   ├── main.ts                        # Interactive mode
│   │   └── service.ts                     # Production daemon
│   └── web/                               # Dashboard + API
├── agents/                                # Built-in subagent definitions
├── workflows/                             # Built-in workflow definitions
└── bin/
    ├── setup.sh                           # First-time setup
    ├── deploy.sh                          # Build + deploy
    └── majordomo                          # CLI wrapper

~/.local/share/majordomo/                  # Deploy home
├── current/                               # Active deployment
└── previous/                              # Last known good (rollback)

~/.majordomo/                              # State home (persistent)
├── memory/                                # COG memory (never wiped)
├── data/                                  # Sessions, DBs, scratch
├── config/                                # User agents & workflows
└── logs/                                  # Application logs
```

---

## Configuration

**Environment:** `~/.majordomo/.env`

```bash
PORT=3000                                  # Web dashboard port
MAJORDOMO_STATE=~/.majordomo               # State directory
MAJORDOMO_HOME=~/.local/share/majordomo    # Deploy directory
TELEGRAM_BOT_TOKEN=                        # Optional: Telegram bot
ANTHROPIC_API_KEY=                         # Optional: Anthropic
OPENAI_API_KEY=                            # Optional: OpenAI
```

**GitHub Copilot (recommended):** run `pi` → `/login` → GitHub Copilot (no API key needed)

See `.env.example` for all options including IMAP, custom paths, and pi binary location.

---

## Development

```bash
# Run from source
bun packages/agent/main.ts                 # Interactive CLI
bun packages/agent/main.ts personal        # Specific domain
bun packages/agent/service.ts              # Full service (all domains + web)

# Build
bun install                                # Install dependencies
bun run build                              # Build all packages

# Deploy
bash bin/deploy.sh                         # Build → copy to deploy home
```

---

## LLM providers

| Provider | Configuration |
|----------|--------------|
| GitHub Copilot | `pi` → `/login` → GitHub Copilot (recommended) |
| Anthropic | `ANTHROPIC_API_KEY=sk-ant-...` in `.env` |
| OpenAI | `OPENAI_API_KEY=sk-...` in `.env` |

Per-agent model override: edit `model.provider` / `model.id` in agent definitions.

---

## License

MIT
