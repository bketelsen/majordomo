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
import { app as webApp, PORT as WEB_PORT, webEvents, websocketHandler } from "../web/src/server.ts";
import { isCompiledBinary, defaultAgents, defaultWorkflows, personaContent } from "../web/src/assets.ts";
import { createLogger } from "./lib/logger.ts";
import { fileExists } from "../shared/lib/fs-helpers.ts";
import { setGlobalManager, setGlobalWebEvents, setGlobalTelegram } from "./lib/shared-state.ts";
import "../shared/types.ts";

const logger = createLogger({ context: { component: "service" } });

// ── Paths ─────────────────────────────────────────────────────────────────────

// Cross-platform home directory: Linux/macOS (HOME), Windows (USERPROFILE), containers (/root)
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "/root";
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



// ── Sanity checks ─────────────────────────────────────────────────────────────

// Helper: resolve agents/workflows directory with user config precedence
const resolveConfigDir = async (userDir: string, defaultDir: string): Promise<string> => {
  try {
    await fs.access(userDir);
    return userDir;  // User config exists, use it
  } catch (err) {
    logger.debug("User config dir not accessible, using default", { userDir, error: err });
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
    const exists = await fileExists(file);
    if (!exists) await fs.writeFile(file, content);
  }
  for (const [name, content] of Object.entries(workflows)) {
    const file = path.join(workflowsDir, `${name}.yaml`);
    const exists = await fileExists(file);
    if (!exists) await fs.writeFile(file, content);
  }
}

// Persona file (in compiled mode, write to state dir; in dev mode, use project root)
let PERSONA_FILE: string;
if (isCompiledBinary()) {
  PERSONA_FILE = path.join(MAJORDOMO_STATE, "persona.md");
  const exists = await fileExists(PERSONA_FILE);
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
  const exists = await fileExists(p);
  if (!exists) {
    logger.error("Required path not found", { path: p, message: "Run: bun packages/agent/scripts/bootstrap.ts" });
    process.exit(1);
  }
}

// ── Domain context manager ───────────────────────────────────────────────────

logger.info("🏛  Majordomo Service starting");
logger.info("Resolved startup paths", resolvedPaths);

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
setGlobalManager(manager);

// Expose webEvents globally so extensions can subscribe to web events
setGlobalWebEvents(webEvents);

// Forward agent session events to the web event bus
sharedEventBus.on("domain:created", (data: unknown) => webEvents.emit("domain:created", data));
sharedEventBus.on("domain:deleted", (data: unknown) => webEvents.emit("domain:deleted", data));
sharedEventBus.on("domain:switched", (data: unknown) => webEvents.emit("domain:switched", data));
sharedEventBus.on("agent:token", (data: unknown) => webEvents.emit("agent:token", data));
sharedEventBus.on("agent:done", (data: unknown) => webEvents.emit("agent:done", data));
sharedEventBus.on("agent:thinking", (data: unknown) => webEvents.emit("agent:thinking", data));
sharedEventBus.on("agent:tool_start", (data: unknown) => webEvents.emit("agent:tool_start", data));
sharedEventBus.on("agent:tool_end", (data: unknown) => webEvents.emit("agent:tool_end", data));

// Forward workflow events to the web event bus
sharedEventBus.on("workflow:started", (data: unknown) => webEvents.emit("workflow:started", data));
sharedEventBus.on("workflow:step_start", (data: unknown) => webEvents.emit("workflow:step_start", data));
sharedEventBus.on("workflow:step_complete", (data: unknown) => webEvents.emit("workflow:step_complete", data));
sharedEventBus.on("workflow:step_failed", (data: unknown) => webEvents.emit("workflow:step_failed", data));
sharedEventBus.on("workflow:complete", (data: unknown) => webEvents.emit("workflow:complete", data));

// ── Web server (in-process) ───────────────────────────────────────────────────


// TLS cert paths — use Tailscale certs if available for direct HTTPS without proxy
const TLS_CERT = process.env.TLS_CERT_FILE ?? path.join(MAJORDOMO_STATE, 'tls', 'framework.goat-snake.ts.net.crt');
const TLS_KEY  = process.env.TLS_KEY_FILE  ?? path.join(MAJORDOMO_STATE, 'tls', 'framework.goat-snake.ts.net.key');
const tlsAvailable = await fileExists(TLS_CERT);

// Use Bun.serve for native WebSocket support (/term PTY endpoint)
Bun.serve({
  port: WEB_PORT,
  ...(tlsAvailable ? {
    tls: {
      cert: Bun.file(TLS_CERT),
      key: Bun.file(TLS_KEY),
    }
  } : {}),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/term') {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return webApp.fetch(req);
  },
  websocket: websocketHandler,
});
logger.info("Dashboard listening", { url: `${tlsAvailable ? 'https' : 'http'}://localhost:${WEB_PORT}` });
if (tlsAvailable) logger.info("TLS enabled", { cert: TLS_CERT });

// ── Telegram bot (optional) ───────────────────────────────────────────────────

let telegram: TelegramBot | null = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  telegram = new TelegramBot({
    manager,
    dataRoot: DATA_ROOT,
  });
  await telegram.start();
} else {
  logger.info("TELEGRAM_BOT_TOKEN not set — running without Telegram");
  logger.info("Set it in .env or environment to enable Telegram integration");
}

logger.info("✅  Majordomo Service ready", {
  domains: (await manager.domains()).join(", ") || "(none)",
  telegram: telegram ? "connected" : "disabled",
  web: `http://localhost:${WEB_PORT}`,
  tailscale: `tailscale serve --bg https / http://localhost:${WEB_PORT}`
});

// Expose telegram instance for in-process web relay
setGlobalTelegram(telegram);

// Persona wizard — fires async, doesn't block service start
runPersonaWizardIfNeeded(MAJORDOMO_STATE, async (text) => {
  await manager.switchDomain("general");
  return manager.sendMessage(text);
}).catch(err =>
  logger.warn("Persona wizard error", { error: err })
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  logger.info("Shutting down", { signal });
  try {
    await telegram?.stop();
    manager.dispose();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { error: err });
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Keep the process alive (prevents Node.js from exiting)
process.stdin.resume();
