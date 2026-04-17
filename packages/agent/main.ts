/**
 * Majordomo — Personal AI Chief-of-Staff
 *
 * Usage:
 *   bun main.ts                    # Start in 'general' domain
 *   bun main.ts --domain personal  # Start in a specific domain
 *   bun main.ts --domain work/acme # Start in a nested domain
 *
 * Prerequisites:
 *   1. Run `bun scripts/bootstrap.ts` once to initialize memory structure
 *   2. Run `pi` and use `/login` to authenticate with GitHub Copilot (or set ANTHROPIC_API_KEY)
 *   3. The session will use credentials from ~/.pi/agent/auth.json automatically
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { cogMemoryExtensionFactory } from "./extensions/cog-memory/index.ts";
import { domainManagerExtensionFactory } from "./extensions/domain-manager/index.ts";
import { subagentManagerExtensionFactory } from "./extensions/subagent-manager/index.ts";
import { schedulerExtensionFactory } from "./extensions/scheduler/index.ts";
import { fileExists } from "../shared/lib/fs-helpers.ts";

// ── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const MEMORY_ROOT = path.join(PROJECT_ROOT, "memory");
const DATA_ROOT = path.join(PROJECT_ROOT, "data");
const PERSONA_FILE = path.join(PROJECT_ROOT, "packages", "agent", "persona", "majordomo.md");
const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, "workflows");

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const domainFlag = args.indexOf("--domain");
const domain = domainFlag !== -1 ? args[domainFlag + 1] : "general";

if (!domain || domain.startsWith("--")) {
  console.error("Usage: bun main.ts [--domain <domain-id>]");
  process.exit(1);
}

// ── Sanity checks ────────────────────────────────────────────────────────────

const memoryExists = await fileExists(MEMORY_ROOT);
if (!memoryExists) {
  console.error("❌  memory/ directory not found. Run: bun scripts/bootstrap.ts");
  process.exit(1);
}

const domainsFile = path.join(MEMORY_ROOT, "domains.yml");
const domainsExist = await fileExists(domainsFile);
if (!domainsExist) {
  console.error("❌  memory/domains.yml not found. Run: bun scripts/bootstrap.ts");
  process.exit(1);
}

// ── Session file ─────────────────────────────────────────────────────────────

const sessionDir = path.join(DATA_ROOT, "sessions", domain);
await fs.mkdir(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "session.jsonl");

// ── Persona ───────────────────────────────────────────────────────────────────

let personaText = `You are Majordomo, a personal AI chief-of-staff.\nActive domain: ${domain}`;
try {
  personaText = await fs.readFile(PERSONA_FILE, "utf-8");
  // Inject active domain into persona
  personaText = personaText.replace("{{ACTIVE_DOMAIN}}", domain);
} catch (err) {
  console.debug('[main] persona/majordomo.md not found, using default persona:', err);
  console.warn("⚠️  persona/majordomo.md not found, using default persona");
}

// ── Auth / Model ──────────────────────────────────────────────────────────────

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// ── Resource loader with extensions ──────────────────────────────────────────

const loader = new DefaultResourceLoader({
  cwd: PROJECT_ROOT,
  systemPromptOverride: () => personaText,
  extensionFactories: [
    cogMemoryExtensionFactory({ memoryRoot: MEMORY_ROOT, getDomain: () => domain }),
    domainManagerExtensionFactory({ memoryRoot: MEMORY_ROOT, dataRoot: DATA_ROOT, projectRoot: PROJECT_ROOT, getDomain: () => domain }),
    subagentManagerExtensionFactory({ projectRoot: PROJECT_ROOT, agentsDir: AGENTS_DIR, workflowsDir: WORKFLOWS_DIR, dataRoot: DATA_ROOT, memoryRoot: MEMORY_ROOT, getDomain: () => domain }),
    schedulerExtensionFactory({ projectRoot: PROJECT_ROOT, dataRoot: DATA_ROOT, agentsDir: AGENTS_DIR, workflowsDir: WORKFLOWS_DIR, getDomain: () => domain }),
  ],
});
await loader.reload();

// ── Session ───────────────────────────────────────────────────────────────────

console.log(`\n🏛  Majordomo starting — domain: ${domain}`);
console.log(`   Session: ${sessionFile}`);
console.log(`   Memory:  ${MEMORY_ROOT}\n`);

const { session, modelFallbackMessage } = await createAgentSession({
  cwd: PROJECT_ROOT,
  authStorage,
  modelRegistry,
  resourceLoader: loader,
  sessionManager: SessionManager.open(sessionFile),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
});

if (modelFallbackMessage) {
  console.warn(`⚠️  ${modelFallbackMessage}`);
  console.warn("   Run `pi` and use /login to authenticate with GitHub Copilot or set ANTHROPIC_API_KEY\n");
}

// ── Event streaming ───────────────────────────────────────────────────────────

let isStreaming = false;

session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      isStreaming = true;
      process.stdout.write("\n🤖  ");
      break;

    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;

    case "tool_execution_start":
      process.stdout.write(`\n   ⚙  ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)}...)\n`);
      break;

    case "agent_end":
      isStreaming = false;
      process.stdout.write("\n\n");
      prompt();
      break;
  }
});

// ── Interactive loop ──────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function prompt() {
  rl.question(`[${domain}]> `, async (input) => {
    const text = input.trim();

    if (!text) {
      prompt();
      return;
    }

    if (text === "/quit" || text === "/exit") {
      console.log("👋  Goodbye");
      session.dispose();
      rl.close();
      process.exit(0);
    }

    try {
      await session.prompt(text);
    } catch (err) {
      console.error(`\n❌  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      prompt();
    }
  });
}

// Handle Ctrl+C gracefully
rl.on("close", () => {
  console.log("\n👋  Goodbye");
  session.dispose();
  process.exit(0);
});

// Start
prompt();
