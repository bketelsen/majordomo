# Using COG Memory in Majordomo

COG is the persistent memory architecture that gives Majordomo long-term context across conversations. It's plain text files organized by domain — no database, no embeddings. The agent reads them, writes them, and maintains them using the tools available in every session.

Canonical reference: **https://lab.puga.com.br/cog/**

---

## How it works

Memory lives in `~/.majordomo/memory/` organized by domain (topic area). Each domain has a set of markdown files that the agent reads at the start of conversations and writes to as things happen. There's no magic — the agent is just instructed to maintain these files and follow the rules for each one.

---

## Domains

A **domain** is a topic area with its own memory files. Majordomo ships with:

| Domain | Purpose |
|--------|---------|
| `general` | Cross-domain fallback, system tasks |
| `personal` | Family, health, calendar, day-to-day life |
| `microsoft` | Work context |
| `majordomo` | Majordomo project development |
| `cog-meta` | Majordomo's self-knowledge and pipeline health |

Domains are defined in `~/.majordomo/memory/domains.yml`. Add new ones by asking Majordomo to create them, or edit the YAML directly.

### Switching domains

```
/switch personal          # explicit switch
"let's talk about work"   # agent will suggest switching
```

---

## Memory files

Each domain has a standard set of files. The rules for each are **strictly enforced** — writing in the wrong mode is blocked.

### `hot-memory.md` — rewrite freely
Top-of-mind context for the domain. Short, current, under 50 lines. The agent rewrites this freely as the situation changes. Read at the start of every relevant conversation.

```markdown
<!-- L0: personal hot memory — active cross-domain state -->
# Personal Hot Memory

## Current Focus
- Active project: acme-api redesign | [[work/action-items]]
```

### `observations.md` — append only
A timestamped log of what happened, what was learned, what changed. Never edited — only appended.

```
- 2026-04-14 [milestone]: Shipped v2 auth refactor — reduced login latency by 40%.
- 2026-04-14 [health]: Owner reports energy low after Q1 crunch — pace deliberately reduced.
```

Valid tags: `health`, `habits`, `family`, `milestone`, `work`, `insight`, `regression`, `philosophy`, `mental-health`

### `action-items.md` — add, complete, update
Open tasks with priority and due dates. Never free-text edited — use the structured tools.

```
- [ ] Submit Q1 roadmap | due:2026-04-20 | pri:critical | added:2026-04-01
- [x] Complete onboarding docs (done 2026-04-01)
```

### `entities.md` — patch sections only, 3 lines max per entry
A registry of people, places, and named things. Each entry is a `### Name` heading with at most 3 lines of facts.

```markdown
### Alex (partner)
partner | met 2015 | shared interests: hiking, cooking
status: active | last: 2026-04-01
```

### `health.md` / `habits.md` — patch sections only
Domain-specific structured files. Only `patch_section` writes allowed — never rewrite the whole file.

### `calendar.md` — rewrite freely
Upcoming events and recurring dates. Rewritten as events are added or expire.

### `dev-log.md` — append or rewrite
Development notes and decisions for project domains.

---

## L0 headers

Every memory file starts with a one-line summary comment:

```markdown
<!-- L0: personal hot memory — current priorities and state -->
```

This is the **index layer** — the agent can scan all L0 headers in a domain with a single cheap call to find which files are relevant, without reading everything. Keep L0s accurate when rewriting files.

---

## Wiki-links

Files can reference each other with `[[domain/file]]` or `[[domain/file#Section]]` syntax:

```markdown
See also: [[personal/action-items]]
See also: [[personal/entities#Alex]]
```

The agent follows these links when context is needed. Keep them accurate — broken links cause confusion.

---

## Glacier (archival)

When files get too long, the agent archives older content to `~/.majordomo/memory/glacier/{domain}/`. Glacier files are read-only and searchable. The `glacier/index.md` is auto-generated — never edit it manually.

---

## cog-meta domain

The `cog-meta` domain is Majordomo's self-knowledge store:

| File | Purpose |
|------|---------|
| `patterns.md` | Universal interaction rules, loaded every turn. Hard cap: 70 lines. |
| `foresight-nudge.md` | Latest cross-domain strategic nudge from `/cog-foresight` |
| `self-observations.md` | Majordomo's observations about its own behavior |
| `improvements.md` | Queued self-improvement ideas |

---

## COG pipeline commands

These commands trigger background cognition tasks:

| Command | What it does |
|---------|-------------|
| `/cog-foresight` | Scans all domains, produces one strategic nudge |
| `/cog-reflect` | Reviews recent conversations, updates memory, extracts patterns |
| `/cog-housekeeping` | Archives stale data, rebuilds indexes, audits links |
| `/cog-evolve` | Audits Majordomo's architecture and proposes improvements |

---

## Blocked writes

Some files are protected and cannot be written by tools:

- `glacier/index.md` — auto-generated
- `*/INDEX.md` — auto-generated  
- `link-index.md` — auto-generated

Attempting to write these returns an error.

---

## Adding a domain

```
"Create a new domain called 'fitness' for tracking workouts and nutrition"
```

Majordomo will create the directory, scaffold the standard files with L0 headers, register it in `domains.yml`, and make it immediately available. You can also add `workingDir` to point subagents at a project directory:

```yaml
- id: goldenpath
  path: projects/goldenpath
  type: project
  label: "GoldenPath project"
  workingDir: /home/bjk/projects/goldenpath
  triggers: [goldenpath]
```

---

## Tips

- **Don't fight the file rules.** They exist to keep memory coherent. If you want to log something, it's an observation. If you want to track a task, it's an action item.
- **Hot memory should stay short.** If it's over 50 lines, it's too detailed — move the detail to observations or entities.
- **L0s drift.** After rewriting a hot-memory file, update its L0 header to match the new content.
- **The agent reads memory, not searches it.** There's no vector search. Files that aren't loaded aren't visible. Keep hot-memory current.
