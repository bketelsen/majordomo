# Majordomo Test Suite

Comprehensive test suite for the Majordomo agent using Bun's built-in test runner.

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test packages/agent/tests/domain-context-manager.test.ts

# Run with watch mode
bun test --watch
```

## Test Files

### 1. domain-context-manager.test.ts
Tests the DomainContextManager class that manages domain context switching in the single-session architecture.

**Coverage:**
- `initialize()` reads domains.yml and sets activeDomain to 'general'
- `switchDomain()` changes activeDomain
- `switchDomain()` throws on unknown domains
- `switchDomain()` throws on archived domains
- `domains()` returns active domain IDs (excludes archived)
- Error handling when no domains are configured

**Approach:** Uses temporary directories with minimal domains.yml fixtures for isolation.

### 2. cog-memory.test.ts
Tests COG memory write rule enforcement logic.

**Coverage:**
- **hot-memory.md**: rewrite allowed, append/patch blocked
- **observations.md**: append allowed, rewrite/patch blocked
- **action-items.md**: append and patch_section allowed, rewrite blocked
- **glacier/index.md**: all writes blocked (auto-generated)
- ***/INDEX.md**: all writes blocked (auto-generated)
- **habits.md**: only patch_section allowed
- **entities.md**: only patch_section allowed
- **health.md**: only patch_section allowed
- **cog-meta/patterns.md**: only patch_section allowed
- **link-index.md**: all writes blocked (auto-generated)
- Default behavior: all modes allowed for unknown files (threads, custom files)

**Approach:** Tests the write rule logic directly without mocking the full extension.

### 3. subagent-manager.test.ts
Tests subagent run tracking (SQLite database operations).

**Coverage:**
- `openRunsDb()` creates schema with runs table
- `createRun()` inserts a run record
- `updateRun()` updates status/output/error/retries/finishedAt
- `getRun()` retrieves by ID
- `getRun()` returns null for non-existent ID
- `getRecentRuns()` returns sorted by started_at desc
- `getRecentRuns()` respects limit parameter
- Full lifecycle: create → update → retrieve

**Approach:** Uses temporary SQLite files, cleaned up after each test.

### 4. scheduler.test.ts
Tests scheduler database operations and COG pipeline job registration.

**Coverage:**
- `openDb()` creates jobs and runs tables
- `ensureCogJobs()` inserts the 4 COG pipeline jobs
- `ensureCogJobs()` is idempotent (INSERT OR IGNORE)
- Jobs have correct cron expressions
- Jobs have correct action_type ('pi_command')
- Jobs have correct command in action_data
- Jobs are enabled by default
- Custom jobs can be inserted
- Runs table can track job executions

**Expected COG Pipeline Jobs:**
- `cog-foresight-daily`: `0 7 * * *` (7am daily)
- `cog-reflect-weekly`: `0 2 * * 0` (2am Sunday)
- `cog-housekeeping-weekly`: `0 3 * * 0` (3am Sunday)
- `cog-evolve-weekly`: `0 4 * * 0` (4am Sunday)

**Approach:** Uses temporary SQLite files.

### 5. workflow-template.test.ts
Tests workflow template resolution logic.

**Coverage:**
- `{{workflow.input.key}}` resolves to workflow input
- `{{steps.id.output}}` resolves to step output text
- `{{steps.id.output.field}}` resolves to JSON field from step output
- `{{steps.id.output.field}}` falls back to full output if not valid JSON
- `{{steps.id.output.field}}` falls back to full output if field not found in JSON
- Missing keys resolve to empty string
- Multiple placeholders in one template
- Nested JSON field access
- Numeric and boolean values in JSON
- Combined workflow input and step outputs

**Approach:** Tests the template resolution logic in isolation.

### 6. domain-manager.test.ts
Tests domain YAML operations and file scaffolding.

**Coverage:**
- `readDomainsManifest()` parses domains.yml correctly
- `readDomainsManifest()` returns empty domains array if file does not exist
- `readDomainsManifest()` handles nested domain paths
- `writeDomainsManifest()` writes valid YAML
- `writeDomainsManifest()` preserves domain structure on round-trip
- `scaffoldDomainFiles()` creates expected files with L0 headers
- `scaffoldDomainFiles()` creates nested domain directories
- `scaffoldDomainFiles()` does not overwrite existing files
- `scaffoldDomainFiles()` handles all standard file types
- `scaffoldDomainFiles()` creates correct titles from file names

**Approach:** Uses temporary directories for full file system operations.

## Test Philosophy

- **No Mocks**: Tests use real file system and real SQLite databases
- **Isolated**: Each test uses temporary directories/databases, cleaned up in `afterEach`
- **Comprehensive**: Tests cover happy paths, edge cases, and error conditions
- **Fast**: All 64 tests run in ~1.4 seconds

## Test Statistics

- **Total Tests**: 64
- **Total Assertions**: 163
- **Files**: 6
- **Pass Rate**: 100%
- **Average Runtime**: ~1.4 seconds
