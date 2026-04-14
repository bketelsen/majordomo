/**
 * Majordomo Service — Daemon entry point
 *
 * Runs the single Majordomo session and connects it to web + Telegram.
 * This is what systemd runs. For interactive single-domain use, see main.ts.
 *
 * Usage:
 *   majordomo dev
 *   TELEGRAM_BOT_TOKEN=... majordomo dev
 *
 * Without TELEGRAM_BOT_TOKEN: runs without Telegram integration.
 * With TELEGRAM_BOT_TOKEN: also starts Telegram bot.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { serve } from "@hono/node-server";
import { DomainContextManager, sharedEventBus } from "./lib/domain-context-manager.ts";
import { TelegramBot } from "./lib/telegram-bot.ts";
import { runPersonaWizardIfNeeded } from "./lib/persona-wizard.ts";
import { app as webApp, PORT as WEB_PORT, webEvents } from "../web/src/server.ts";
import { isCompiledBinary, defaultAgents, defaultWorkflows, personaContent } from "../web/src/assets.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME!;
const PROJECT_ROOT = process.cwd();

// State home (persistent data, memory, config)
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");

// Core state paths
const MEMORY_ROOT = path.join(MAJORDOMO_STATE, "memory");
const DATA_ROOT = path.join(MAJORDOMO_STATE, "data");
const CONFIG_ROOT = path.join(MAJORDOMO_STATE, "config");

// Agent/workflow search paths (user config takes precedence)
const AGENTS_DIR_USER = path.join(CONFIG_ROOT, "agents");
const AGENTS_DIR_DEFAULT = path.join(PROJECT_ROOT, "agents");
const WORKFLOWS_DIR_USER = path.join(CONFIG_ROOT, "workflows");
const WORKFLOWS_DIR_DEFAULT = path.join(PROJECT_ROOT, "workflows");

// Persona file (always from project root)
// const PERSONA_FILE = path.join(PROJECT_ROOT, "packages", "agent", "persona", "majordomo.md");

// ── Sanity checks ─────────────────────────────────────────────────────────────

// Helper: resolve agents/workflows directory with user config precedence
const resolveConfigDir = async (userDir: string, defaultDir: string): Promise<string> => {
  try {
    await fs.access(userDir);
    return userDir;  // User config exists, use it
  } catch {
    return defaultDir;  // Fall back to default
  }
};

// Write embedded defaults when running as compiled binary
async function writeEmbeddedDefaults(
  configRoot: string,
  agents: Record<string, string>,
  workflows: Record<string, string>
): Promise<void> {
  const agentsDir = path.join(configRoot, 'agents');
  const workflowsDir = path.join(configRoot, 'workflows');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(workflowsDir, { recursive: true });
  
  for (const [name, content] of Object.entries(agents)) {
    const file = path.join(agentsDir, `${name}.md`);
    const exists = await fs.access(file).then(() => true).catch(() => false);
    if (!exists) await fs.writeFile(file, content);
  }
  for (const [name, content] of Object.entries(workflows)) {
    const file = path.join(workflowsDir, `${name}.yaml`);
    const exists = await fs.access(file).then(() => true).catch(() => false);
    if (!exists) await fs.writeFile(file, content);
  }
}

// Persona file (in compiled mode, write to state dir; in dev mode, use project root)
let PERSONA_FILE: string;
if (isCompiledBinary()) {
  PERSONA_FILE = path.join(MAJORDOMO_STATE, "persona.md");
  const exists = await fs.access(PERSONA_FILE).then(() => true).catch(() => false);
  if (!exists) {
    await fs.writeFile(PERSONA_FILE, personaContent);
  }
} else {
  PERSONA_FILE = path.join(PROJECT_ROOT, "packages", "agent", "persona", "majordomo.md");
}

const agentsDir = await resolveConfigDir(AGENTS_DIR_USER, AGENTS_DIR_DEFAULT);
const workflowsDir = await resolveConfigDir(WORKFLOWS_DIR_USER, WORKFLOWS_DIR_DEFAULT);

// Write embedded defaults to config if running as compiled binary
if (isCompiledBinary()) {
  await writeEmbeddedDefaults(CONFIG_ROOT, defaultAgents, defaultWorkflows);
}
const envFile = path.join(MAJORDOMO_STATE, ".env");
const resolvedPaths = {
  PROJECT_ROOT,
  MAJORDOMO_STATE,
  MEMORY_ROOT,
  DATA_ROOT,
  CONFIG_ROOT,
  AGENTS_DIR_USER,
  AGENTS_DIR_DEFAULT,
  WORKFLOWS_DIR_USER,
  WORKFLOWS_DIR_DEFAULT,
  agentsDir,
  workflowsDir,
  PERSONA_FILE,
  envFile,
};

for (const p of [MEMORY_ROOT, path.join(MEMORY_ROOT, "domains.yml")]) {
  const exists = await fs.access(p).then(() => true).catch(() => false);
  if (!exists) {
    console.error(`❌  Not found: ${p}\nRun: bun packages/agent/scripts/bootstrap.ts`);
    process.exit(1);
  }
}

// ── Domain context manager ───────────────────────────────────────────────────

console.log("\n🏛  Majordomo Service starting...\n");
console.log("[service] Resolved startup paths:");
for (const [key, value] of Object.entries(resolvedPaths)) {
  console.log(`   ${key}: ${value}`);
}
console.log("");

const manager = new DomainContextManager({
  projectRoot: PROJECT_ROOT,
  memoryRoot: MEMORY_ROOT,
  dataRoot: DATA_ROOT,
  personaFile: PERSONA_FILE,
  agentsDir,
  workflowsDir,
});

await manager.initialize();

// Expose manager globally so the web server can route messages to it
(globalThis as Record<string, unknown>).__majordomoManager = manager;

// Forward agent session events to the web event bus
sharedEventBus.on("domain:created", (data: unknown) => webEvents.emit("domain:created", data));
sharedEventBus.on("domain:deleted", (data: unknown) => webEvents.emit("domain:deleted", data));
sharedEventBus.on("domain:switched", (data: unknown) => webEvents.emit("domain:switched", data));
sharedEventBus.on("agent:token", (data: unknown) => webEvents.emit("agent:token", data));
sharedEventBus.on("agent:done", (data: unknown) => webEvents.emit("agent:done", data));
sharedEventBus.on("agent:thinking", (data: unknown) => webEvents.emit("agent:thinking", data));
sharedEventBus.on("agent:tool_start", (data: unknown) => webEvents.emit("agent:tool_start", data));
sharedEventBus.on("agent:tool_end", (data: unknown) => webEvents.emit("agent:tool_end", data));

// ── Web server (in-process) ───────────────────────────────────────────────────

serve({ fetch: webApp.fetch, port: WEB_PORT }, (info) => {
  console.log(`[web] Dashboard listening on http://localhost:${info.port}`);
});

// ── Telegram bot (optional) ───────────────────────────────────────────────────

let telegram: TelegramBot | null = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  telegram = new TelegramBot({
    manager,
    dataRoot: DATA_ROOT,
  });
  await telegram.start();
} else {
  console.log("[service] TELEGRAM_BOT_TOKEN not set — running without Telegram");
  console.log("[service] Set it in .env or environment to enable Telegram integration");
}

console.log("\n✅  Majordomo Service ready\n");
console.log("   Domains:", (await manager.domains()).join(", ") || "(none)");
console.log("   Telegram:", telegram ? "connected" : "disabled");
console.log(`   Web:      http://localhost:${WEB_PORT}`);
console.log("   Tailscale: run: tailscale serve --bg https / http://localhost:" + WEB_PORT + "\n");

// Expose telegram instance for in-process web relay
(globalThis as Record<string, unknown>).__majordomoTelegram = telegram;

// Persona wizard — fires async, doesn't block service start
runPersonaWizardIfNeeded(MAJORDOMO_STATE, async (text) => {
  await manager.switchDomain("general");
  return manager.sendMessage(text);
}).catch(err =>
  console.warn("[wizard] Error:", err)
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`\n[service] Received ${signal}, shutting down...`);
  try {
    await telegram?.stop();
    manager.dispose();
    console.log("[service] Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[service] Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Keep the process alive
await new Promise(() => {});
