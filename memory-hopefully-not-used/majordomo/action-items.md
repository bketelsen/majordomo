<!-- L0: majordomo tasks — open and completed action items -->
# Action Items
- [x] Investigate subagent spawn overhead — process.argv[1] likely re-initializes full service stack (done 2026-04-14)
- [ ] Wire up thinking: high and other model flags from agent YAML to pi CLI spawn args | pri:low | domain:dev | added:2026-04-14
- [ ] Implement SQLite-backed subagent run tracking (currently in-memory only, Phase 5) | pri:med | domain:dev | added:2026-04-14
- [ ] Revisit Aspen fork for Majordomo-native skill/context generation — keep generation pipeline, replace Claude Code hooks with Pi SDK extension + file watcher, output to COG memory instead of .claude/ | due:2026-04-18 | pri:med | domain:dev | added:2026-04-14
- [x] Fix scheduler/subagent extensions loading 3x (once per domain session) — scheduler fires jobs 3x against same DB. Should be singleton on general session only. (done 2026-04-14)
- [ ] Enhance workflow template engine to support nested output field access — {{steps.id.output.field}} for structured agent outputs (needed for files_changed handoff to QA) | pri:med | domain:dev | added:2026-04-14
- [ ] Implement deployment architecture — state to ~/.majordomo/, deploy to ~/.local/share/majordomo/, CLI bin/majordomo with start/stop/deploy/rollback. Docs in data/scratch/DEPLOYMENT_*.md. ~18h work. | pri:high | domain:dev | added:2026-04-14
- [ ] Add persona override path — check MAJORDOMO_STATE/config/persona.md first, fall back to packages/agent/persona/majordomo.md (same pattern as agents/workflows) | pri:low | domain:dev | added:2026-04-14
