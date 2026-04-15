# Copilot Instructions for Majordomo

## Project Overview
Majordomo is a Bun-based personal AI chief-of-staff with:
- A long-running agent service (`packages/agent/service.ts`)
- An interactive CLI agent (`packages/agent/main.ts`)
- A web dashboard (`packages/web/src/server.ts`)
- Domain-aware memory and tool extensions (under `packages/agent/extensions/`)

## Tech Stack
- Runtime: Bun
- Language: TypeScript (ESM)
- Tests: Bun test
- Process management: systemd units in `systemd/`

## Repository Layout
- `packages/agent/`: Core agent, extensions, persona, scripts, and tests
- `packages/web/`: Dashboard server and web plugin infrastructure
- `bin/`: Setup/deploy/build/CLI scripts
- `docs/`: Specs, implementation notes, deployment docs
- `workflows/`: Multi-agent workflow definitions

## Local Development
Prefer these commands:
- Install dependencies: `make install`
- Run service (dev): `make dev`
- Run interactive agent: `make agent`
- Run tests: `make test`
- Run typecheck: `make typecheck`
- Run deploy flow: `make deploy`

## Coding Guidelines
- Keep changes minimal and scoped to the requested task.
- Preserve current file and naming conventions.
- Favor small, composable functions over large blocks of logic.
- Avoid introducing new dependencies unless clearly justified.
- Keep TypeScript strictness in mind and avoid `any` when possible.
- Add or update tests in `packages/agent/tests/` when behavior changes.

## Agent and Extension Conventions
- New extension behavior should align with existing patterns in:
  - `packages/agent/extensions/cog-memory/`
  - `packages/agent/extensions/domain-manager/`
  - `packages/agent/extensions/subagent-manager/`
  - `packages/agent/extensions/scheduler/`
- Domain-aware behavior should be compatible with `domain-context-manager.ts`.
- Persona-facing behavior should remain consistent with `packages/agent/persona/majordomo.md`.

## Web Plugin Conventions
- Web plugins live under `packages/web/plugins/`.
- Keep plugin contracts consistent with `plugin.json` + `client.ts` + `server.ts` patterns.
- Maintain compatibility with plugin loading in `packages/web/src/plugin-loader.ts`.

## Deployment and Runtime Safety
- Treat deploy/runtime scripts in `bin/` as production-critical.
- Do not change service/unit behavior in `systemd/` unless explicitly requested.
- Prefer additive, backward-compatible changes for persisted state under `~/.majordomo/`.

## Documentation Expectations
When making behavior or interface changes:
- Update relevant docs in `README.md`, `docs/`, or plugin READMEs.
- Keep examples and commands copy-pasteable.

## Pull Request Expectations
- Include a concise summary of what changed and why.
- Mention any user-visible behavior changes.
- Note tests executed (or why tests were not run).
