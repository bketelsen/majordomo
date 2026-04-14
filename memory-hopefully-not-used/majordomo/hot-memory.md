<!-- L0: majordomo project hot memory — current focus and state -->
# Hot Memory — Majordomo

## Current Focus
- Active development of the Majordomo AI agent system
- Codebase: /home/bjk/projects/sionapi (monorepo, Bun/TypeScript)

## Resolved Today
- ✅ Subagent spawn overhead — fixed, now uses pi binary directly
- ✅ SQLite-backed run tracking — implemented in subagents.db
- ✅ Scheduler triplication — fixed, general session only
- ✅ Widget collapsing + sidebar scroll
- ✅ Thinking blocks + tool call indicators in web UI
- ✅ workingDir in domain schema + subagent spawn

## Open Items
- Architect plan for state/deploy separation — in flight (run: architect-1776164094512-n308)
- Workflow template nested field access ({{steps.id.output.field}})
- thinking: high agent flag not passed to pi CLI (low pri)
- Aspen fork decision — due 2026-04-18
- Personal domain migration from ~/.siona/memory — URGENT (tax deadline 2026-04-15)

## Architecture Notes
- Subagents spawn via /home/linuxbrew/.linuxbrew/bin/pi with --mode json -p --no-session
- Default subagent cwd: data/scratch/ (isolated from source tree)
- Extensions: cog-memory, domain-manager, subagent-manager (general only for crons), scheduler
- Memory: memory/ (COG format) | Sessions: data/sessions/ | DBs: data/scheduler.db, data/subagents.db
