# Majordomo — Technical Specification

> Version 1.0 — Derived from design interview, April 2026

---

## 1. Vision

Majordomo is a personal AI chief-of-staff. It is proactive (scheduled tasks, event-driven alerts), reactive (responds to conversation), and delegating (spawns specialized subagents for complex work). It is accessible via a rich web dashboard and via Telegram, runs on your Linux home lab as a systemd service, and uses your existing LLM subscriptions rather than pay-per-token API keys.

Every piece of contextual memory the LLM reasons over is managed exclusively by the COG memory system. Everything else — message history, config, subagent state — uses whatever persistence store is appropriate for the job.

---

## 2. Core Principles

| Principle | Decision |
|-----------|----------|
| Agent loop | `@mariozechner/pi-agent-core` via `@mariozechner/pi-coding-agent` SDK |
| Memory / context | COG filesystem — injected into system prompt via pi extension |
| Agent-side hooks | pi extensions wherever possible |
| Web UI | Separate service, communicates with agent via pi RPC or shared event bus |
| Deployment | Linux, systemd, Tailscale Serve for web access |
| LLM primary | GitHub Copilot API (subscription, OAuth — no per-token cost) |
| Auth | Tailscale identity (single user, no traditional auth layer needed) |
| Persona | Chief-of-staff, loaded from markdown, overlaid with COG domain context |

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          MAJORDOMO SYSTEM                            │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    majordomo-agent (systemd)                   │  │
│  │                                                               │  │
│  │   pi-agent-core AgentSession (main Majordomo session)        │  │
│  │                                                               │  │
│  │   Pi Extensions:                                              │  │
│  │   ├── cog-memory          inject COG domain into sys prompt  │  │
│  │   ├── domain-manager      create/destroy COG + Telegram + UI │  │
│  │   ├── telegram-bot        receive/send messages per domain   │  │
│  │   ├── scheduler           cron + event-driven triggers       │  │
│  │   ├── subagent-manager    spawn/monitor async pi sub-sessions│  │
│  │   ├── workflow-engine     chain subagents with schemas       │  │
│  │   └── web-bridge          WebSocket event bus to dashboard   │  │
│  │                                                               │  │
│  │   Tool extensions:                                            │  │
│  │   ├── cog_read / cog_write   read+write COG domain memory    │  │
│  │   ├── spawn_subagent         trigger a named subagent        │  │
│  │   ├── run_workflow           trigger a named workflow        │  │
│  │   └── dashboard_push         push data to a named widget     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                │                                     │
│                    WebSocket / Unix socket                           │
│                                │                                     │
│  ┌─────────────────────────────▼─────────────────────────────────┐  │
│  │               majordomo-web (systemd)                          │  │
│  │                                                               │  │
│  │   Hono (TypeScript) API + static SvelteKit frontend           │  │
│  │                                                               │  │
│  │   ├── /api/domains          list domains                     │  │
│  │   ├── /api/messages/:domain paginated message history        │  │
│  │   ├── /api/widgets/:name    widget data endpoint             │  │
│  │   ├── /ws                   real-time streaming to UI        │  │
│  │   └── static/*              SvelteKit dashboard bundle       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                │                                     │
│                          Tailscale Serve                             │
│                          (HTTPS, no extra auth)                      │
└──────────────────────────────────────────────────────────────────────┘

External:
  Telegram Bot API ──► telegram-bot extension
  GitHub / webhooks ──► scheduler extension
  Email IMAP ──► scheduler extension (polling or IDLE)
  Docker / Incus API ──► widget data sources
```

---

## 4. Repository Structure

```
majordomo/
├── packages/
│   ├── agent/                    # majordomo-agent service
│   │   ├── extensions/
│   │   │   ├── cog-memory/       # COG context injection
│   │   │   ├── domain-manager/   # domain lifecycle
│   │   │   ├── telegram-bot/     # Telegram integration
│   │   │   ├── scheduler/        # cron + event triggers
│   │   │   ├── subagent-manager/ # async subagent sessions
│   │   │   ├── workflow-engine/  # subagent chaining
│   │   │   └── web-bridge/       # WebSocket event relay
│   │   ├── agents/               # subagent definitions (YAML+md)
│   │   │   ├── researcher.md
│   │   │   ├── architect.md
│   │   │   ├── developer.md
│   │   │   └── qa.md
│   │   ├── workflows/            # workflow definitions (YAML)
│   │   │   └── research-to-impl.yaml
│   │   ├── persona/
│   │   │   └── majordomo.md      # base system prompt / soul
│   │   ├── config/
│   │   │   └── majordomo.yaml    # domain→telegram mappings, etc.
│   │   ├── main.ts               # agent process entry point
│   │   └── package.json
│   │
│   └── web/                      # majordomo-web service
│       ├── src/
│       │   ├── server/           # Hono API + WebSocket server
│       │   └── client/           # SvelteKit dashboard
│       └── package.json
│
├── memory/                       # COG memory filesystem (repo root — COG convention)
│   ├── domains.yml               # Domain SSOT
│   ├── hot-memory.md             # Cross-domain hot memory
│   ├── cog-meta/                 # Self-improvement + pipeline state
│   ├── general/
│   ├── personal/
│   ├── work/
│   └── glacier/
├── data/
│   ├── sessions/                 # pi JSONL session files per domain
│   ├── telegram-map.yaml         # Domain → Telegram thread_id mapping
│   └── widgets/                  # widget data cache (JSON files)
│
├── systemd/
│   ├── majordomo-agent.service
│   └── majordomo-web.service
│
└── package.json                  # workspace root
```

---

## 5. Data Stores

| Store | Technology | Purpose |
|-------|-----------|---------|
| COG memory | Filesystem (`memory/`) — COG conventions | LLM context per domain — selectively injected via L0→L1→L2 protocol |
| Domain manifest | `memory/domains.yml` | **SSOT** for all COG domains — managed by domain-manager extension |
| Session history | pi JSONL files (`data/sessions/{domain}.jsonl`) | Full conversation + tool call history per domain |
| Telegram mapping | `data/telegram-map.yaml` | Domain name → Telegram `thread_id` mapping (separate from COG's domains.yml) |
| Subagent registry | `agents/*.md` (YAML frontmatter) | Subagent persona, model, tools, schemas |
| Workflow definitions | `workflows/*.yaml` | Chained subagent pipeline definitions |
| Widget cache | `data/widgets/{name}.json` | Last-known widget data, TTL-refreshed |
| Scheduler state | SQLite (`data/scheduler.db`) | Scheduled job registry, event source registry, run history |
| Subagent run state | SQLite (`data/subagents.db`) | Active runs, workflow state, chaining queue |

---

## 6. COG Memory Integration (`cog-memory` extension)

COG uses a **three-tier memory system** (Hot / Warm / Glacier) with a strict **L0 → L1 → L2 retrieval protocol**. The extension does NOT dump all domain files into the system prompt. Instead it injects a minimal always-read set and gives Majordomo tools to selectively load additional context on demand.

### Directory Layout (COG conventions)
```
memory/
  domains.yml                  # SSOT — all domain definitions
  hot-memory.md                # Cross-domain always-read (<50 lines)
  link-index.md                # Backlink index (auto-generated by /housekeeping)
  cog-meta/
    patterns.md                # Distilled universal patterns — always-read
    self-observations.md       # Append-only Cog self-improvement log
    improvements.md            # Ideas and wishlist
    reflect-cursor.md          # Session path + ingestion cursor for /reflect
    scenario-calibration.md
    foresight-nudge.md         # Written by /foresight, consumed each morning
    briefing-bridge.md         # Written by /housekeeping, consumed by /foresight
    scenarios/
  personal/
    hot-memory.md              # Domain hot memory (<50 lines)
    observations.md            # Append-only timestamped events
    action-items.md            # Task list with priority/due date
    entities.md                # 3-line compact entity registry
    calendar.md
    health.md
    INDEX.md                   # Auto-generated by /housekeeping — L0 map of domain
  work/
    {job-name}/
      hot-memory.md
      ...
      INDEX.md
  glacier/
    index.md                   # Glacier catalog — YAML frontmatter per archived file
    {domain}/
      observations-{tag}.md
      action-items-done.md
      ...
```

### Memory Tiers

| Tier | Files | Loaded |
|------|-------|--------|
| **Hot** | `*/hot-memory.md` | Always, every conversation (<50 lines each) |
| **Warm** | Domain files (observations, entities, action-items, etc.) | On demand via L0→L1→L2 tools |
| **Glacier** | `memory/glacier/` — YAML-frontmatted archives | Via glacier search tool only |

### L0 → L1 → L2 Protocol

Every memory file has `<!-- L0: one-line summary -->` as its first line.

| Level | Action | Decision |
|-------|--------|----------|
| **L0** | `grep -rn "<!-- L0:" memory/{domain}/` | Is this file relevant? |
| **L1** | Scan `##` section headers | Which section is relevant? |
| **L2** | Read full file or targeted section | Get the actual content |

**Decision rules:**
1. Uncertain which files are relevant → L0 scan first (one grep, many files, few tokens)
2. File confirmed relevant AND >80 lines → L1 scan before full read
3. File <80 lines, or full context needed → go directly to L2
4. Hot-memory files are always L2 (small by design, always worth full read)

### What `before_agent_start` Injects (always, every turn)

```
1. Majordomo persona          (persona/majordomo.md)
2. Cross-domain hot memory    (memory/hot-memory.md)
3. Universal patterns         (memory/cog-meta/patterns.md)
4. Domain hot memory          (memory/{active_domain}/hot-memory.md)
   — walks up for nested: work/hot-memory.md → work/acme/hot-memory.md
5. Domain L0 scan result      (grep output — tiny, tells agent what files exist)
6. Domain INDEX.md            (memory/{active_domain}/INDEX.md if exists)
7. Foresight nudge            (memory/cog-meta/foresight-nudge.md if written today)
```

This is intentionally lean. The agent then uses COG tools to load specific warm files as the query demands.

### COG Tools (registered by this extension)

```typescript
cog_l0_scan(domain?: string)
  // grep <!-- L0: headers across a domain directory
  // returns: [{file, l0_summary}]
  // default domain = active domain for this session

cog_l1_scan(file_path: string)
  // extract ## and ### section headers from a COG file
  // returns: [{level, heading, line_number}]
  // use before full-reading any file >80 lines

cog_read(file_path: string, section?: string)
  // read a COG file (L2), optionally a specific ## section by heading text
  // resolves paths relative to memory/

cog_write(file_path: string, content: string, mode: WriteMode)
  // mode: "rewrite" | "append" | "patch_section"
  // enforces per-file edit patterns (table below)
  // automatically adds/updates <!-- L0: --> header on every write

cog_append_observation(domain: string, text: string, tags: string[])
  // appends: "- YYYY-MM-DD [tag1, tag2]: text" to {domain}/observations.md
  // creates file with L0 header if it doesn't exist

cog_update_action_item(domain: string, action: "add"|"complete"|"update", task: string, options?)
  // enforces format: "- [ ] task | due:YYYY-MM-DD | pri:high | domain:tag | added:YYYY-MM-DD"
  // complete: marks "- [ ]" → "- [x] task (done YYYY-MM-DD)"

cog_glacier_search(domain?: string, tags?: string[], date_range?: string)
  // reads memory/glacier/index.md and filters by params — does NOT open glacier files
  // returns matching file paths for agent to decide which to open with cog_read

cog_wiki_follow(link: string)
  // resolves [[domain/filename]] or [[domain/filename#Section]] wiki-link
  // respects L1 decision: scans headers first if file >80 lines
```

### File Edit Patterns Enforced by `cog_write`

| File | Allowed modes | Notes |
|------|--------------|-------|
| `hot-memory.md` | rewrite | Keep <50 lines |
| `observations.md` | append only | Never edit past entries |
| `action-items.md` | append, patch_section | Append new; patch to check off done |
| `entities.md` | patch_section | Max 3 content lines per `### Entry` |
| `calendar.md` | rewrite | Edit in place |
| `health.md` | patch_section | Current State: rewrite; History: append |
| Thread files | patch_section + append | Current State: rewrite; Timeline: append only |
| `cog-meta/self-observations.md` | append only | Max 5 new entries per /reflect pass |
| `cog-meta/patterns.md` | patch_section | Hard cap: 70 lines / 5.5KB |
| `glacier/index.md` | **blocked** | Auto-generated by /housekeeping only |
| `link-index.md` | **blocked** | Auto-generated by /housekeeping only |
| `*/INDEX.md` | **blocked** | Auto-generated by /housekeeping only |

### `memory/domains.yml` — The Domain SSOT

COG's canonical domain registry. The `domain-manager` extension writes here when domains are created or archived. `cog-memory` reads it at startup to build the domain→path map.

```yaml
domains:
  - id: general
    path: general
    type: general
    label: "Fallback — no specific domain context"
    triggers: []
    files: [hot-memory, action-items, observations]

  - id: personal
    path: personal
    type: personal
    label: "Family, health, calendar, day-to-day"
    triggers: [family, health, kids, calendar, personal, home]
    files: [hot-memory, action-items, observations, entities, health, calendar]

  - id: cog-meta
    path: cog-meta
    type: system
    label: "Majordomo self-knowledge and pipeline health"
    triggers: [cog, meta, evolve, memory, architecture]
    files: [self-observations, patterns, improvements]
```

---

## 7. Domain Manager (`domain-manager` extension)

Domains are the central organizing unit. **`memory/domains.yml` is the COG SSOT** for domain definitions. Telegram thread IDs live separately in `data/telegram-map.yaml` so COG's manifest is never polluted with infrastructure concerns.

### On domain creation (user request → Majordomo executes):
1. Append new entry to `memory/domains.yml`
2. Create `memory/{domain}/` directory
3. Scaffold standard COG files, each with a correct `<!-- L0: ... -->` header:
   - `hot-memory.md`
   - `observations.md`
   - `action-items.md`
   - `entities.md`
4. Create `data/sessions/{domain}/` directory for pi session JSONL files
5. Create Telegram forum topic in the configured supergroup — store returned `thread_id` in `data/telegram-map.yaml`
6. Emit `domain:created` on `pi.events` → web-bridge relays → new tab appears in dashboard

### On domain deletion:
1. Mark domain `status: archived` in `memory/domains.yml` (never remove the entry — COG history preservation)
2. Move `memory/{domain}/` → `memory/glacier/{domain}/` (follows COG glacier convention)
3. Archive session JSONL files to `data/sessions/.archived/{domain}/`
4. Mark Telegram topic `archived: true` in `data/telegram-map.yaml`
5. Emit `domain:deleted` on `pi.events`

### Telegram mapping file (`data/telegram-map.yaml`):
```yaml
# Telegram topic → domain mapping
# Managed by domain-manager extension. NOT part of COG memory.
telegram:
  bot_token_env: TELEGRAM_BOT_TOKEN
  supergroup_id: -100xxxxxxxxxx

topics:
  general:
    thread_id: null          # General uses main supergroup thread
    created_at: 2026-04-14
  personal:
    thread_id: 12345
    created_at: 2026-04-14
  work:
    thread_id: 12346
    created_at: 2026-04-14
```

---

## 8. Telegram Integration (`telegram-bot` extension)

### Message routing:
- Incoming message in forum topic → look up `telegram_thread_id` in config → load that domain's pi session → send to agent
- Outgoing agent response → send to correct forum topic via `message_thread_id`
- Proactive messages (from scheduler, subagent completions) → sent to `general` thread (or domain-specific if context is clear)

### Session-per-domain:
Each domain maintains its own pi `AgentSession`. The Telegram bot extension holds a `Map<domainName, AgentSession>` and routes accordingly.

### Message persistence:
Telegram messages are stored in the domain's pi session JSONL as standard user/assistant messages. The web UI reads the same JSONL to display history. Telegram message IDs are stored in message `details` for deduplication.

### Telegram → Web sync:
```
Telegram user message
  → bot extension receives update
  → appended to domain session JSONL
  → pi.events emits message:new {domain, message}
  → web-bridge relays via WebSocket
  → web UI appends to chat view
```

### Web → Telegram (best-effort):
Web UI submits message → API → web-bridge → pi.events → telegram-bot extension → sends message to Telegram forum topic as a bot message with "(via web)" tag. This is best-effort; if it fails, message still exists in session.

---

## 9. Subagent System (`subagent-manager` extension)

### Subagent definition format (`agents/researcher.md`):
```yaml
---
name: researcher
label: "Deep Research Specialist"
model:
  provider: copilot          # or: anthropic, openai, codex
  id: gpt-4.1               # model ID within that provider
  thinking: high
tools:
  - web_search
  - read
  - bash
  - cog_read
cog_domain: null             # null = inherit caller's domain context
                             # or: "research" = always inject this domain
max_turns: 30
timeout_minutes: 15
input_schema:
  type: object
  properties:
    query: { type: string }
    depth: { type: string, enum: [shallow, deep] }
    context: { type: string }
  required: [query]
output_schema:
  type: object
  properties:
    summary: { type: string }
    sources: { type: array, items: { type: string } }
    confidence: { type: number }
    raw_findings: { type: string }
  required: [summary]
on_failure:
  retry: 2
  then: report_to_majordomo  # options: report_to_majordomo, escalate_to_user, abort
---

# Researcher Agent

You are a meticulous research specialist. Given a query, you conduct
thorough research using available tools and produce a structured summary
with cited sources...
```

### Subagent lifecycle:
```
Majordomo decides to spawn researcher
  → subagent-manager.spawn("researcher", { query: "...", context: "..." })
  → creates new pi AgentSession with:
     - researcher's system prompt (from .md file)
     - researcher's tools
     - COG context injected (if cog_domain set, or inherited)
     - structured input appended as first user message
  → records run in subagents.db: { id, type, status: running, spawned_at, parent_domain }
  → runs session.prompt() asynchronously
  → on agent_end: validate output against output_schema
  → on success: emits subagent:complete { id, type, output } on pi.events
  → on failure: retry logic → then report to Majordomo via pi.sendUserMessage()
  → Majordomo receives completion, summarizes for user
```

### Majordomo receives completion:
```typescript
pi.events.on("subagent:complete", ({ id, type, output }) => {
  pi.sendUserMessage(
    `Subagent ${type} (${id}) completed.\n\nOutput:\n${JSON.stringify(output, null, 2)}`,
    { deliverAs: "followUp" }
  );
});
```

### Non-blocking guarantee:
Each subagent runs in a separate async context. Majordomo's main session remains responsive. The `subagent-manager` maintains a pool and enforces a configurable max concurrency.

---

## 10. Workflow Engine (`workflow-engine` extension)

### Workflow definition (`workflows/research-to-impl.yaml`):
```yaml
name: research-to-implementation
description: Research a topic, design it, implement it, validate it
steps:
  - id: research
    agent: researcher
    input:
      query: "{{workflow.input.topic}}"
      depth: deep

  - id: architect
    agent: architect
    depends_on: research
    input:
      findings: "{{steps.research.output.summary}}"
      sources: "{{steps.research.output.sources}}"

  - id: implement
    agent: developer
    depends_on: architect
    input:
      design: "{{steps.architect.output.design_doc}}"
      constraints: "{{steps.architect.output.constraints}}"

  - id: validate
    agent: qa
    depends_on: implement
    input:
      implementation: "{{steps.implement.output.diff}}"
      test_plan: "{{steps.architect.output.test_plan}}"

on_complete:
  notify: true
  summary_agent: majordomo   # Majordomo summarizes the whole workflow result
```

### Workflow execution:
- Steps with `depends_on` wait for their dependency to complete successfully
- Steps without `depends_on` run in parallel
- Template expressions (`{{steps.X.output.Y}}`) are resolved at step launch time
- Majordomo is notified on workflow completion with the full result tree
- Majordomo can also trigger a workflow by name via the `run_workflow` tool

---

## 11. COG Pipeline Skills (as pi commands + scheduled tasks)

COG defines four pipeline skills that maintain memory health. In Majordomo these map to:
1. **Pi commands** — triggerable in any chat (`/cog-foresight`, `/cog-reflect`, etc.)
2. **Scheduled tasks** — auto-registered in `scheduler.db` on first startup

Each is implemented as a pi command that spawns a **dedicated subagent** with the COG skill's markdown instructions as its system prompt, full `cog_read`/`cog_write`/`cog_l0_scan` tool access, and a 30-minute timeout.

| COG Skill | Pi command | Default schedule | What it does |
|-----------|-----------|-----------------|----------------------------------------------------------|
| `/foresight` | `/cog-foresight` | Daily 07:00 | Cross-domain nudge — writes `cog-meta/foresight-nudge.md` |
| `/reflect` | `/cog-reflect` | Weekly Sun 02:00 | Mines pi session JSONLs, condenses observations→patterns, flags thread candidates |
| `/housekeeping` | `/cog-housekeeping` | Weekly Sun 03:00 | Archives stale data, prunes hot-memory, rebuilds glacier index + link-index + domain INDEX.md files |
| `/evolve` | `/cog-evolve` | Weekly Sun 04:00 | Architecture audit — reads self-observations + improvements, proposes rule changes |

### `/reflect` ↔ Pi Session JSONL Integration

COG's `/reflect` skill mines session transcripts to catch unresolved threads, broken promises, and memory gaps. **Pi session JSONL files are structurally identical to Claude Code's JSONL files** — same `type: "user"` / `type: "assistant"` message format. No adapter needed.

The reflect subagent:
1. Reads `memory/cog-meta/reflect-cursor.md` for `session_path` and `last_processed` timestamp
2. Globs `data/sessions/**/*.jsonl` for files modified after `last_processed`
3. Extracts user messages: `type: "user"` lines where `message.content` is a **string** (arrays = tool results, skip)
4. Extracts assistant text: `type: "assistant"` lines, content items with `type: "text"`
5. Updates `last_processed` in `reflect-cursor.md` after ingestion

On first run, `reflect-cursor.md` is initialized with `session_path: data/sessions/` and `last_processed: never` → reflect reads the 3 most recent sessions.

### `/foresight` Morning Delivery

The foresight subagent writes `memory/cog-meta/foresight-nudge.md` daily. The `cog-memory` extension checks this file's mtime in `before_agent_start` — if written today, it's injected into the system prompt. The nudge surfaces organically in the first conversation of the day without a push notification.

---

## 11a. Scheduler (`scheduler` extension)

### Built-in scheduled jobs (auto-registered on first startup):
```yaml
- id: cog-foresight-daily
  cron: "0 7 * * *"
  action: { type: pi_command, command: "/cog-foresight" }

- id: cog-reflect-weekly
  cron: "0 2 * * 0"
  action: { type: pi_command, command: "/cog-reflect" }

- id: cog-housekeeping-weekly
  cron: "0 3 * * 0"
  action: { type: pi_command, command: "/cog-housekeeping" }

- id: cog-evolve-weekly
  cron: "0 4 * * 0"
  action: { type: pi_command, command: "/cog-evolve" }
```

### Two additional trigger types at launch:

**Time-based (cron):**
```yaml
# Stored in scheduler.db, manageable via conversation
- id: morning-brief
  cron: "0 7 * * *"
  action:
    type: agent_prompt
    domain: general
    message: "Good morning. Please give me a brief for today."
```

**Event-driven:**
```yaml
- id: github-pr-review
  type: webhook
  endpoint: /webhooks/github   # Majordomo's web-bridge exposes this
  filter:
    event: pull_request_review
    repo: "myorg/*"
  action:
    type: agent_prompt
    domain: work
    message: "New PR review received: {{event.payload}}"
```

### Trigger sources at launch:
- Cron expressions (via `node-cron` or similar)
- Incoming webhooks (registered on web-bridge's HTTP server)
- Email polling (IMAP IDLE or interval fetch)

### Extensibility hook:
The scheduler extension exposes a `register_event_source` tool and command so Majordomo can add new watchers at runtime via conversation. New sources are persisted to `scheduler.db`.

---

## 12. Web Dashboard

### Stack:
- **Backend:** Hono (TypeScript, Node.js) — API server, WebSocket hub, webhook receiver
- **Frontend:** SvelteKit — server-side rendered shell, reactive chat and widget panels
- **Transport:** WebSocket for real-time updates (new messages, widget refreshes, subagent status)
- **Storage bridge:** reads pi session JSONL files directly for message history; reads `data/widgets/` for widget data

### Layout:
```
┌────────────────────────────────────────────────────────────┐
│  Majordomo          [general] [personal] [work] [+]        │
├──────────────────────────────┬─────────────────────────────┤
│                              │  DASHBOARD PANELS           │
│   DOMAIN CHAT                │                             │
│                              │  ┌─────────────────────┐   │
│   [Telegram msg shown here]  │  │ 🔥 Active Priorities │   │
│   [Web msg shown here]       │  │ · Ship auth module   │   │
│   [Agent response]           │  │ · Review PR #42      │   │
│   ...                        │  └─────────────────────┘   │
│                              │  ┌─────────────────────┐   │
│   [typing area]        [↑]   │  │ 🐋 Containers        │   │
│                              │  │ ● nginx   [stop]     │   │
│                              │  │ ● postgres [stop]    │   │
│                              │  └─────────────────────┘   │
│                              │  ┌─────────────────────┐   │
│                              │  │ 📬 Recent Email      │   │
│                              │  │ · Alice: standup..   │   │
│                              │  │ · GitHub: PR merged  │   │
│                              │  └─────────────────────┘   │
│                              │  ┌─────────────────────┐   │
│                              │  │ ⚙ Subagent Workflows │   │
│                              │  │ ⟳ research-to-impl  │   │
│                              │  │   step 2/4: architect│   │
│                              │  └─────────────────────┘   │
└──────────────────────────────┴─────────────────────────────┘
```

### Hardcoded widgets (Phase 1):

| Widget | Data Source | Refresh | Interactive |
|--------|------------|---------|-------------|
| Active Priorities | COG `{domain}/action-items.md` — parsed markdown checklist | On COG write | Click to mark done (cog_write) |
| Running Containers | Docker socket or Incus API | 30s | Stop / Start button |
| Recent Email | IMAP fetch | 5min | Mark read |
| Subagent Workflows | `subagents.db` | Real-time (WebSocket) | Cancel button |
| Upcoming Scheduled | `scheduler.db` | On change | Delete / trigger now |

### Message history:
- Web UI loads paginated message history from domain's JSONL session file via `/api/messages/{domain}`
- Only human↔agent pairs are shown (tool calls and internal events filtered out)
- New messages streamed in real-time via WebSocket

---

## 13. LLM Provider Strategy

### Primary: GitHub Copilot
GitHub Copilot exposes an OpenAI-compatible API at `https://api.githubcopilot.com`. Authentication uses GitHub OAuth (not a per-token API key), making it free under your subscription.

```typescript
// Registered via pi.registerProvider() in a dedicated extension
pi.registerProvider("copilot", {
  baseUrl: "https://api.githubcopilot.com",
  api: "openai-completions",
  authHeader: true,
  oauth: {
    name: "GitHub Copilot",
    async login(callbacks) {
      // GitHub Device Flow OAuth
    },
    async refreshToken(credentials) { ... },
    getApiKey(credentials) { return credentials.access; }
  },
  models: [
    { id: "gpt-4.1", name: "GPT-4.1 (Copilot)", ... },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet (Copilot)", ... },
    { id: "o3", name: "o3 (Copilot)", ... },
  ]
});
```

### Secondary: Anthropic (Claude Code subscription)
Claude Code subscriptions provide Anthropic API access. Standard `ANTHROPIC_API_KEY` env var. Used for Majordomo's main reasoning when a task demands it or for specific subagents.

### Tertiary: OpenAI / Codex
Standard `OPENAI_API_KEY`. Used for antagonistic/adversarial reviewer subagents or tasks that benefit from GPT-5/Codex specifically.

### Per-subagent model assignment:
Each subagent YAML specifies `model.provider` and `model.id`. Majordomo can also override at spawn time based on task complexity or cost considerations.

### ⚠️ Subscription vs. API key clarification:
GitHub Copilot's API is accessible under the subscription. For Anthropic and OpenAI, the web subscription (Claude.ai, ChatGPT Plus) is **separate** from API access — the API requires its own key and has its own billing. Claude Code specifically does include API credits. Verify your Claude Code plan tier before assuming zero API cost. This may mean Anthropic usage is API-billed while Copilot is subscription-free.

---

## 14. Majordomo Persona

Loaded from `persona/majordomo.md`. Structure:

```markdown
# Majordomo

You are Majordomo, the personal chief-of-staff for [USER_NAME].

## Role
You coordinate, delegate, and execute. You have opinions and share them.
You push back when you see a better path, but ultimately defer to your user.
You proactively surface information without being asked when it's relevant.

## Operating principles
- When a task is complex, prefer spawning a specialist subagent over attempting it yourself
- When a domain context is relevant but not active, note it and offer to switch
- Keep responses concise. Use structured output (lists, headers) for complex information.
- When you complete a task, briefly state what you did and what's next

## User context
[Name, timezone, working style, communication preferences — filled in at setup]

## What you always know
[Loaded from memory/hot-memory.md at runtime by cog-memory extension]
```

---

## 15. Deployment

### Systemd services:

**`/etc/systemd/system/majordomo-agent.service`:**
```ini
[Unit]
Description=Majordomo AI Agent
After=network.target

[Service]
Type=simple
User=bjk
WorkingDirectory=/home/bjk/majordomo/data
ExecStart=/usr/bin/node /home/bjk/majordomo/packages/agent/dist/main.js
EnvironmentFile=/home/bjk/majordomo/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/majordomo-web.service`:**
```ini
[Unit]
Description=Majordomo Web Dashboard
After=majordomo-agent.service

[Service]
Type=simple
User=bjk
WorkingDirectory=/home/bjk/majordomo/packages/web
ExecStart=/usr/bin/node /home/bjk/majordomo/packages/web/dist/server.js
EnvironmentFile=/home/bjk/majordomo/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Tailscale Serve:
```bash
tailscale serve --bg https / http://localhost:3000
# Dashboard available at https://your-machine.your-tailnet.ts.net
```

### Environment (`.env`):
```bash
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...          # For Claude Code plan
OPENAI_API_KEY=...             # For Codex/GPT-5 agents
GITHUB_OAUTH_TOKEN=...         # For Copilot (managed via pi /login)
MAJORDOMO_DATA_DIR=/home/bjk/majordomo/data
MAJORDOMO_WEB_PORT=3000
AGENT_IPC_SOCKET=/tmp/majordomo-agent.sock
```

---

## 16. Build Phases

### Phase 1 — Core Agent + COG Memory
- [ ] Monorepo scaffold (`packages/agent`, `packages/web`)
- [ ] `main.ts` — pi AgentSession with fixed `data/` + `memory/` launch dirs
- [ ] Bootstrap COG directory structure: `memory/domains.yml`, `memory/hot-memory.md`, `memory/cog-meta/patterns.md` with L0 headers
- [ ] `cog-memory` extension:
  - `before_agent_start`: injects hot-memory + patterns + domain hot-memory + L0 scan + INDEX.md + foresight-nudge
  - `cog_l0_scan` tool
  - `cog_l1_scan` tool
  - `cog_read` tool (with optional section)
  - `cog_write` tool (enforces per-file edit patterns)
  - `cog_append_observation` tool
  - `cog_update_action_item` tool
  - `cog_glacier_search` tool
  - `cog_wiki_follow` tool
- [ ] `domain-manager` extension — creates COG dirs + standard files with L0 headers, writes `memory/domains.yml`, writes `data/telegram-map.yaml`
- [ ] Majordomo persona loaded from markdown
- [ ] GitHub Copilot provider registered via `pi.registerProvider`
- [ ] Smoke test: start agent, chat in terminal, COG context injected correctly

### Phase 2 — Telegram
- [ ] `telegram-bot` extension — polling or webhook, per-domain session routing
- [ ] Message persistence in domain JSONL sessions
- [ ] Domain ↔ Telegram forum topic mapping via config
- [ ] Telegram forum topic creation on domain create
- [ ] Smoke test: send Telegram message, get response in correct forum topic

### Phase 3 — Web Dashboard (basic)
- [ ] `web-bridge` extension — WebSocket server on Unix socket, relays `pi.events`
- [ ] Hono API server — `/api/messages/{domain}`, `/api/domains`
- [ ] SvelteKit frontend — domain tabs, chat view, message history
- [ ] Real-time message streaming via WebSocket
- [ ] Cross-surface sync: Telegram message appears in web chat
- [ ] Systemd services + Tailscale Serve setup

### Phase 4 — Subagents + Workflows
- [ ] `subagent-manager` extension — spawn, monitor, complete lifecycle
- [ ] Subagent YAML+markdown loader at startup
- [ ] `spawn_subagent` tool registered for Majordomo
- [ ] `workflow-engine` extension — YAML workflow parser, step chaining, template resolution
- [ ] `run_workflow` tool registered for Majordomo
- [ ] Subagent status widget in web dashboard
- [ ] Smoke test: trigger research→architect workflow, receive completed result

### Phase 5 — Scheduler + Proactivity + COG Pipeline
- [ ] `scheduler` extension — cron trigger via `node-cron`
- [ ] Scheduler SQLite DB + job registry
- [ ] Webhook endpoint on web server → routed to scheduler
- [ ] `register_event_source` tool for Majordomo
- [ ] COG pipeline pi commands: `/cog-foresight`, `/cog-reflect`, `/cog-housekeeping`, `/cog-evolve`
- [ ] Each pipeline command spawns a subagent with the COG skill markdown as system prompt
- [ ] Auto-register COG pipeline cron jobs on first startup
- [ ] Initialize `memory/cog-meta/reflect-cursor.md` with `session_path: data/sessions/`
- [ ] Smoke test: trigger `/cog-housekeeping` manually, verify INDEX.md + link-index.md rebuilt, debrief reported in General

### Phase 6 — Dashboard Widgets
- [ ] Active Priorities widget (COG markdown parse)
- [ ] Running Containers widget (Docker socket)
- [ ] Recent Email widget (IMAP)
- [ ] Subagent Workflows widget (subagents.db)
- [ ] Scheduled Tasks widget (scheduler.db)
- [ ] Interactive widget actions (stop container, mark email read, mark priority done)

### Phase 7 — Polish + Hardening
- [ ] Error recovery for failed subagents (retry → report → escalate)
- [ ] Session compaction for long-running domain chats
- [ ] COG memory management tools (summarize, archive old entries)
- [ ] Web → Telegram message relay (best-effort)
- [ ] Workflow visualization in dashboard
- [ ] Backup strategy for `data/` directory

---

## 17. Open Questions (Decisions Deferred to Implementation)

| Question | Options | Recommendation |
|----------|---------|---------------|
| Agent↔web IPC | Unix socket vs. HTTP vs. shared SQLite | Unix socket (low latency, same machine) |
| Web framework | Hono + SvelteKit vs. Fastify + React | Hono + SvelteKit (TypeScript-native, fast) |
| Telegram polling vs. webhook | Long-polling simpler; webhook needs public endpoint | Polling at launch (no extra infra) |
| COG library integration | Use COG npm package vs. reimplement filesystem convention | Reimplement — COG is a convention set, not an npm library; the spec IS the implementation |
| COG `memory/` location | Repo root vs. `data/memory/` | `memory/` at repo root — matches COG convention, simplifies `/reflect` path config |
| `/reflect` session path | `data/sessions/` vs. per-domain | Single `data/sessions/` root; reflect globs all subdirs |
| Subagent max concurrency | Fixed config vs. dynamic | Config (default: 5) |
| Session JSONL location | `data/sessions/{domain}/latest.jsonl` vs. named | Named by domain, one active session per domain |
| Copilot OAuth token refresh | Handled by pi OAuth layer vs. custom | pi's `registerProvider` oauth flow |

---

*This document is the source of truth for Majordomo's design. Implementation should reference this spec and update it as decisions are made during build.*
