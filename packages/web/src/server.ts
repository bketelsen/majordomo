/**
 * Majordomo Web Server
 *
 * Serves the dashboard and provides the API that the SvelteKit frontend consumes.
 * Communicates with the agent service via:
 *   - Shared DomainContextManager (in-process when run together)
 *   
 *
 * Runs in-process alongside the agent service via service.ts.
 *
 * Routes:
 *   GET  /api/domains              — list active domains
 *   GET  /api/messages/:domain     — paginated message history from JSONL
 *   POST /api/messages/:domain     — send a message to a domain session
 *   GET  /api/widgets/:name        — widget data
 *   POST /api/domains              — create a domain
 *   WS   /ws                       — real-time event stream
 */

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { Database } from "bun:sqlite";
import { readDomainsManifest, type CogDomain } from "../../shared/lib/domains.ts";
import "../../shared/types.ts";

import { loadPlugins, registerPlugins, type LoadedPlugin } from "./plugin-loader.ts";
import { indexHTML, isCompiledBinary, manifest, serviceWorker, appleTouchIcon } from "./assets.ts";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MAJORDOMO_WEB_PORT ?? "3000");
const PROJECT_ROOT = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
const HOME = process.env.HOME ?? "/root";
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");
const MEMORY_ROOT = path.join(MAJORDOMO_STATE, "memory");
const DATA_ROOT = path.join(MAJORDOMO_STATE, "data");
const STATIC_ROOT = path.join(import.meta.dirname, "..", "static");
// In compiled binary, import.meta.dirname is inside /$bunfs/ — plugins must live externally
// Check MAJORDOMO_STATE/plugins first (external, works in compiled mode), fallback to source path
const PLUGIN_DIR_EXTERNAL = path.join(MAJORDOMO_STATE, "plugins");
const PLUGIN_DIR_SOURCE = path.join(import.meta.dirname, "..", "plugins");
const PLUGIN_DIR = await (async () => {
  const externalExists = await fs.access(PLUGIN_DIR_EXTERNAL).then(() => true).catch(() => false);
  return externalExists ? PLUGIN_DIR_EXTERNAL : PLUGIN_DIR_SOURCE;
})();

// ── In-process event bus (agent pushes events here, WS clients consume) ───────

export const webEvents = new EventEmitter();
webEvents.setMaxListeners(100);

// ── WebSocket client registry ──────────────────────────────────────────────────

interface WsClient {
  id: string;
  controller: ReadableStreamDefaultController;
  domain?: string; // if set, only receive events for this domain
}

const wsClients = new Map<string, WsClient>();

function broadcast(event: string, data: unknown, domain?: string): void {
  const payload = `data: ${JSON.stringify({ event, data, ts: Date.now() })}\n\n`;
  for (const client of wsClients.values()) {
    if (domain && client.domain && client.domain !== domain) continue;
    try {
      client.controller.enqueue(new TextEncoder().encode(payload));
    } catch { /* client disconnected */ }
  }
}

// Forward agent events to SSE clients
webEvents.on("agent:token", (data: { domain: string; delta: string }) => {
  broadcast("agent:token", data, data.domain);
});
webEvents.on("agent:done", (data: { domain: string; text: string }) => {
  broadcast("agent:done", data, data.domain);
});
webEvents.on("agent:thinking", (data: { domain: string; delta: string }) => {
  broadcast("agent:thinking", data, data.domain);
});
webEvents.on("agent:tool_start", (data: { domain: string; toolName: string; args: unknown }) => {
  broadcast("agent:tool_start", data, data.domain);
});
webEvents.on("agent:tool_end", (data: { domain: string; toolName: string; isError: boolean }) => {
  broadcast("agent:tool_end", data, data.domain);
});
webEvents.on("domain:created", (data: unknown) => broadcast("domain:created", data));
webEvents.on("domain:deleted", (data: unknown) => broadcast("domain:deleted", data));
webEvents.on("domain:switched", (data: unknown) => broadcast("domain:switched", data));

// Forward workflow events to SSE clients
webEvents.on("workflow:started", (data: unknown) => broadcast("workflow:started", data));
webEvents.on("workflow:step_start", (data: unknown) => broadcast("workflow:step_start", data));
webEvents.on("workflow:step_complete", (data: unknown) => broadcast("workflow:step_complete", data));
webEvents.on("workflow:step_failed", (data: unknown) => broadcast("workflow:step_failed", data));
webEvents.on("workflow:complete", (data: unknown) => broadcast("workflow:complete", data));

// ── JSONL session reader ───────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  kind: "chat";
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  source?: "telegram" | "web" | "interactive";
}

interface ThinkingMessage {
  id: string;
  kind: "thinking";
  text: string;
  timestamp: number;
}

interface ToolCallMessage {
  id: string;
  kind: "tool_call";
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  timestamp: number;
  status: "running" | "success" | "error";
  resultText?: string;
}

type SessionTimelineItem = ChatMessage | ThinkingMessage | ToolCallMessage;

function normalizeTimestamp(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const asNumber = Number(ts);
    if (!Number.isNaN(asNumber) && ts.trim() !== "") return asNumber;
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object" && "type" in c)
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("")
    .trim();
}

// ── Message cache for performance ─────────────────────────────────────────────

interface CachedMessages {
  messages: SessionTimelineItem[];
  timestamp: number;
  fileSize: number;
}

// ── Corruption tracking ───────────────────────────────────────────────────────

interface CorruptionStats {
  domain: string;
  sessionFile: string;
  corruptedLines: number;
  lastCorruptionTimestamp?: number;
  examples: Array<{ lineNumber: number; preview: string; error: string }>;
}

const corruptionStats = new Map<string, CorruptionStats>();
const MAX_CORRUPTION_EXAMPLES = 5;

const messageCache = new Map<string, CachedMessages>();
const CACHE_TTL = 5000; // 5 seconds
const MAX_CACHE_ENTRIES = 50;

function getCacheKey(domain: string, limit: number, before?: number): string {
  return `${domain}:${limit}:${before ?? 'none'}`;
}

function pruneCache(): void {
  if (messageCache.size <= MAX_CACHE_ENTRIES) return;
  const entries = Array.from(messageCache.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  // Remove oldest 25%
  const toRemove = Math.floor(MAX_CACHE_ENTRIES * 0.25);
  for (let i = 0; i < toRemove; i++) {
    messageCache.delete(entries[i][0]);
  }
}

/**
 * Read lines from end of file in reverse order.
 * Optimized for reading recent messages without parsing the entire file.
 */
async function readLinesReverse(filePath: string, maxLines: number): Promise<string[]> {
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const stats = await fileHandle.stat();
    const fileSize = stats.size;
    
    if (fileSize === 0) return [];

    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    let lines: string[] = [];
    let position = fileSize;
    let remainder = '';

    while (position > 0 && lines.length < maxLines) {
      const chunkSize = Math.min(CHUNK_SIZE, position);
      position -= chunkSize;

      const buffer = Buffer.allocUnsafe(chunkSize);
      await fileHandle.read(buffer, 0, chunkSize, position);
      
      const chunk = buffer.toString('utf-8') + remainder;
      const chunkLines = chunk.split('\n');

      // First element might be incomplete line from previous chunk
      remainder = chunkLines[0];
      
      // Process lines in reverse (skip first which is remainder)
      for (let i = chunkLines.length - 1; i >= 1; i--) {
        const line = chunkLines[i].trim();
        if (line) {
          lines.push(line);
          if (lines.length >= maxLines) break;
        }
      }
    }

    // Handle remainder if we've read the entire file
    if (position === 0 && remainder.trim() && lines.length < maxLines) {
      lines.push(remainder.trim());
    }

    return lines;
  } finally {
    await fileHandle.close();
  }
}

function parseMessageEntry(
  line: string, 
  domain: string, 
  isUnifiedHistory: boolean, 
  messages: SessionTimelineItem[], 
  toolCallIndex: Map<string, number>,
  lineNumber?: number,
  sessionFile?: string
): void {
  try {
    const entry = JSON.parse(line);

    const entryDomain = entry.metadata?.domain;
    if (isUnifiedHistory && entryDomain && entryDomain !== domain) return;

    if (entry.type !== "message") return;
    const msg = entry.message;
    if (!msg) return;

    const timestamp = normalizeTimestamp(entry.timestamp ?? msg.timestamp);

    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (!text) return;

      messages.push({
        id: entry.id ?? `u-${messages.length}`,
        kind: "chat",
        role: "user",
        text,
        timestamp,
        source: entry.source,
      });
      return;
    }

    if (msg.role === "assistant") {
      if (!Array.isArray(msg.content)) {
        const text = extractTextContent(msg.content);
        if (text) {
          messages.push({
            id: entry.id ?? `a-${messages.length}`,
            kind: "chat",
            role: "assistant",
            text,
            timestamp,
          });
        }
        return;
      }

      let textBuffer = "";
      let textIndex = 0;
      const flushTextBuffer = () => {
        const text = textBuffer.trim();
        if (!text) {
          textBuffer = "";
          return;
        }
        messages.push({
          id: `${entry.id ?? `a-${messages.length}`}-text-${textIndex++}`,
          kind: "chat",
          role: "assistant",
          text,
          timestamp,
        });
        textBuffer = "";
      };

      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "text") {
          textBuffer += part.text ?? "";
          continue;
        }

        flushTextBuffer();

        if (part.type === "thinking") {
          const thinking = (part.thinking ?? "").trim();
          if (!thinking) continue;
          messages.push({
            id: `${entry.id ?? `a-${messages.length}`}-thinking-${messages.length}`,
            kind: "thinking",
            text: thinking,
            timestamp,
          });
          continue;
        }

        if (part.type === "toolCall") {
          const item: ToolCallMessage = {
            id: `${entry.id ?? `a-${messages.length}`}-tool-${messages.length}`,
            kind: "tool_call",
            toolCallId: part.id,
            toolName: part.name ?? "tool",
            args: part.arguments,
            timestamp,
            status: "running",
          };
          messages.push(item);
          if (part.id) toolCallIndex.set(part.id, messages.length - 1);
        }
      }

      flushTextBuffer();
      return;
    }

    if (msg.role === "toolResult") {
      const resultText = extractTextContent(msg.content);
      const idx = msg.toolCallId ? toolCallIndex.get(msg.toolCallId) : undefined;

      if (idx !== undefined) {
        const existing = messages[idx];
        if (existing && existing.kind === "tool_call") {
          existing.status = msg.isError ? "error" : "success";
          existing.resultText = resultText;
          return;
        }
      }

      messages.push({
        id: entry.id ?? `tr-${messages.length}`,
        kind: "tool_call",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName ?? "tool",
        timestamp,
        status: msg.isError ? "error" : "success",
        resultText,
      });
    }
  } catch (error) {
    // Log corruption and emit metrics
    const errorMessage = error instanceof Error ? error.message : String(error);
    const preview = line.length > 100 ? line.substring(0, 100) + '...' : line;
    
    // Track corruption stats
    const statsKey = sessionFile || domain;
    let stats = corruptionStats.get(statsKey);
    if (!stats) {
      stats = {
        domain,
        sessionFile: sessionFile || 'unknown',
        corruptedLines: 0,
        examples: [],
      };
      corruptionStats.set(statsKey, stats);
    }
    
    stats.corruptedLines++;
    stats.lastCorruptionTimestamp = Date.now();
    
    // Keep limited examples
    if (stats.examples.length < MAX_CORRUPTION_EXAMPLES) {
      stats.examples.push({
        lineNumber: lineNumber ?? -1,
        preview,
        error: errorMessage,
      });
    }
    
    // Log warning with context
    console.warn(
      `[session-corruption] Malformed JSONL line in ${sessionFile || domain}` +
      (lineNumber ? ` at line ${lineNumber}` : '') +
      `\n  Error: ${errorMessage}` +
      `\n  Preview: ${preview}`
    );
    
    // Emit event for monitoring/alerting
    webEvents.emit('session:corruption_detected', {
      domain,
      sessionFile: sessionFile || 'unknown',
      lineNumber: lineNumber ?? -1,
      preview,
      error: errorMessage,
      timestamp: Date.now(),
    });
  }
}

async function readSessionMessages(domain: string, limit = 100, before?: number): Promise<SessionTimelineItem[]> {
  const unifiedSessionFile = path.join(DATA_ROOT, "sessions", "session.jsonl");
  const legacySessionFile = path.join(DATA_ROOT, "sessions", domain, "session.jsonl");
  const sessionFile = await fs.access(unifiedSessionFile).then(() => unifiedSessionFile).catch(() => legacySessionFile);

  const exists = await fs.access(sessionFile).then(() => true).catch(() => false);
  if (!exists) return [];

  // Check cache
  const cacheKey = getCacheKey(domain, limit, before);
  const cached = messageCache.get(cacheKey);
  
  if (cached) {
    const stats = await fs.stat(sessionFile);
    const now = Date.now();
    
    // Cache hit if file hasn't changed and cache is fresh
    if (stats.size === cached.fileSize && (now - cached.timestamp) < CACHE_TTL) {
      return cached.messages;
    }
    
    // Invalidate stale cache
    messageCache.delete(cacheKey);
  }

  const isUnifiedHistory = sessionFile === unifiedSessionFile;
  const messages: SessionTimelineItem[] = [];
  const toolCallIndex = new Map<string, number>();

  // Optimized reverse reading: estimate we need ~3x lines to get enough domain-filtered messages
  // This is a heuristic that works well when domains are interleaved
  const estimatedLinesToRead = before === undefined ? limit * 3 : limit * 5;
  const lines = await readLinesReverse(sessionFile, estimatedLinesToRead);

  // Process lines in reverse order (most recent first)
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineNumber = lines.length - i; // Approximate line number from end
    parseMessageEntry(lines[i], domain, isUnifiedHistory, messages, toolCallIndex, lineNumber, sessionFile);
  }

  // Apply before filter and limit
  let result = messages;
  if (before !== undefined) {
    const idx = result.findIndex(m => m.timestamp === before);
    if (idx > 0) result = result.slice(0, idx);
  }

  result = result.slice(-limit);

  // Update cache
  const stats = await fs.stat(sessionFile);
  messageCache.set(cacheKey, {
    messages: result,
    timestamp: Date.now(),
    fileSize: stats.size,
  });
  pruneCache();

  return result;
}

// ── Domains helper ─────────────────────────────────────────────────────────────

async function readDomains(): Promise<CogDomain[]> {
  const manifest = await readDomainsManifest(MEMORY_ROOT);
  return manifest.domains.filter(d => d.status !== "archived");
}

// Validate domain ID format to prevent path traversal
function isValidDomainId(id: string): boolean {
  return /^[a-z0-9/_-]+$/.test(id) && !id.includes('..');
}

// ── Plugin registry ───────────────────────────────────────────────────────────

let loadedPlugins: LoadedPlugin[] = [];
let pluginsLoaded = false;

// ── Widget data ────────────────────────────────────────────────────────────────

async function getWidgetData(name: string): Promise<unknown> {
  // Try plugin first
  const plugin = loadedPlugins.find(p => p.manifest.id === name);
  if (plugin) {
    const widgetCtx = {
      id: plugin.manifest.id,
      config: plugin.manifest.config,
      dataDir: path.join(DATA_ROOT, "widgets", plugin.manifest.id),
      broadcast: (event: string, data: unknown) => webEvents.emit(event, data),
      subscribe: (event: string, handler: (data: unknown) => void) => webEvents.on(event, handler),
      db: {
        open: async (name: string) => {
          await fs.mkdir(path.join(DATA_ROOT, "widgets", plugin.manifest.id), { recursive: true });
          const dbPath = path.join(DATA_ROOT, "widgets", plugin.manifest.id, `${name}.db`);
          return new Database(dbPath);
        },
      },
    };
    return await plugin.server.getData(widgetCtx);
  }

  // Fallback to legacy widgets
  switch (name) {
    default: {
      // Try file cache for unknown widget names
      const cachePath = path.join(DATA_ROOT, "widgets", `${name}.json`);
      try {
        const content = await fs.readFile(cachePath, "utf-8");
        return JSON.parse(content);
      } catch {
        return null;
      }
    }
  }
}





// ── Hono app ───────────────────────────────────────────────────────────────────

const app = new Hono();

/**
 * Initialize plugins — MUST be called before server starts accepting requests
 * to prevent race condition where widgets return 404 before plugins load.
 */
async function initializePlugins(): Promise<void> {
  if (pluginsLoaded) return; // Already initialized
  
  console.log('[web] Loading plugins...');
  loadedPlugins = await loadPlugins(PLUGIN_DIR);
  registerPlugins(app, loadedPlugins, { dataRoot: DATA_ROOT, webEvents });
  pluginsLoaded = true;
  console.log(`[web] ✓ Plugins loaded (${loadedPlugins.length} total)`);
}

// Health
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// Session health check — scans for corrupted sessions
app.get("/api/health/sessions", async (c) => {
  const stats = Array.from(corruptionStats.values());
  const totalCorrupted = stats.reduce((sum, s) => sum + s.corruptedLines, 0);
  
  // Scan all session files for potential issues
  const sessionFiles: Array<{ path: string; size: number; accessible: boolean }> = [];
  
  try {
    const unifiedSessionFile = path.join(DATA_ROOT, "sessions", "session.jsonl");
    const unifiedStats = await fs.stat(unifiedSessionFile).catch(() => null);
    if (unifiedStats) {
      sessionFiles.push({
        path: unifiedSessionFile,
        size: unifiedStats.size,
        accessible: true,
      });
    }
  } catch { /* not found */ }
  
  // Check legacy per-domain session files
  try {
    const sessionsDir = path.join(DATA_ROOT, "sessions");
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionFile = path.join(sessionsDir, entry.name, "session.jsonl");
        const sessionStats = await fs.stat(sessionFile).catch(() => null);
        if (sessionStats) {
          sessionFiles.push({
            path: sessionFile,
            size: sessionStats.size,
            accessible: true,
          });
        }
      }
    }
  } catch { /* directory not found */ }
  
  return c.json({
    status: totalCorrupted === 0 ? "healthy" : "degraded",
    totalCorruptedLines: totalCorrupted,
    corruptionStats: stats,
    sessionFiles,
    timestamp: Date.now(),
  });
});

// Reset corruption stats (for testing/recovery)
app.post("/api/health/sessions/reset", (c) => {
  corruptionStats.clear();
  return c.json({ success: true, message: "Corruption stats reset" });
});

// ── Domains API ───────────────────────────────────────────────────────────────

app.get("/api/domains", async (c) => {
  const domains = await readDomains();
  const manager = globalThis.__majordomoManager;
  return c.json({ domains, activeDomain: manager?.getDomain() ?? "general" });
});

app.post("/api/domains/:id/activate", async (c) => {
  const domainId = c.req.param("id");
  const manager = globalThis.__majordomoManager;

  if (!manager) {
    return c.json({ success: false, error: "Agent service not available" }, 503);
  }

  try {
    await manager.switchDomain(domainId);
    return c.json({ success: true, domain: domainId });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 400);
  }
});

// ── Messages API ──────────────────────────────────────────────────────────────

app.get("/api/messages/:domain", async (c) => {
  const domain = c.req.param("domain");
  
  // Validate domain ID format and existence to prevent path traversal
  if (!isValidDomainId(domain)) {
    return c.json({ error: "Invalid domain ID format" }, 400);
  }
  
  const validDomains = await readDomains();
  if (!validDomains.some(d => d.id === domain)) {
    return c.json({ error: "Domain not found" }, 404);
  }
  
  const limit = parseInt(c.req.query("limit") ?? "100");
  const before = c.req.query("before") ? parseInt(c.req.query("before")!) : undefined;

  const messages = await readSessionMessages(domain, limit, before);
  return c.json({ messages, domain });
});

// POST a message to a domain (web UI → agent)
app.post("/api/messages/:domain", async (c) => {
  const domain = c.req.param("domain");
  
  // Validate domain ID format and existence to prevent path traversal
  if (!isValidDomainId(domain)) {
    return c.json({ error: "Invalid domain ID format" }, 400);
  }
  
  const validDomains = await readDomains();
  if (!validDomains.some(d => d.id === domain)) {
    return c.json({ error: "Domain not found" }, 404);
  }
  
  const body = await c.req.json();
  const text: string = body.text;

  if (!text?.trim()) {
    return c.json({ error: "text is required" }, 400);
  }

  const manager = globalThis.__majordomoManager;

  if (!manager) {
    return c.json({ error: "Agent service not available" }, 503);
  }

  if (manager.isStreaming()) {
    return c.json({ error: "Session is busy, try again shortly" }, 409);
  }

  if (manager.getDomain() !== domain) {
    await manager.switchDomain(domain);
  }

  // Fire and forget — client gets the response via SSE
  manager.sendMessage(text, (delta) => {
    webEvents.emit("agent:token", { domain, delta });
  }).then((response) => {
    webEvents.emit("agent:done", { domain, text: response });
    // Relay agent response back to Telegram (best-effort)
    const tg = (globalThis as Record<string, unknown>).__majordomoTelegram as
      { sendToDomain: (d: string, t: string) => Promise<void> } | null;
    tg?.sendToDomain(domain, response).catch(() => {});
  }).catch((err) => {
    webEvents.emit("agent:error", { domain, error: String(err) });
  });

  // Relay user message to Telegram (best-effort, tagged "(via web)")
  const tg = (globalThis as Record<string, unknown>).__majordomoTelegram as
    { sendToDomain: (d: string, t: string) => Promise<void> } | null;
  tg?.sendToDomain(domain, `(via web) ${text}`).catch(() => {});

  return c.json({ queued: true });
});

// ── Widgets API ───────────────────────────────────────────────────────────────

app.get("/api/widgets/:name", async (c) => {
  const name = c.req.param("name");
  const data = await getWidgetData(name);
  if (data === null) return c.json({ error: "Widget not found" }, 404);
  return c.json({ widget: name, data });
});

// Trigger a scheduled job immediately
// POST /api/schedules/:id/trigger moved to schedules plugin

// ── Obsidian sync API ────────────────────────────────────────────────

app.post("/api/obsidian-sync", async (c) => {
  try {
    const { getVaultRoot, writeDailyJournal } = await import("../../agent/lib/obsidian.ts");
    const vaultRoot = getVaultRoot();
    
    if (!vaultRoot) {
      return c.json({ 
        success: false, 
        error: "OBSIDIAN_VAULT not configured" 
      }, 400);
    }

    const result = writeDailyJournal(MEMORY_ROOT);
    
    if (!result) {
      return c.json({ 
        success: false, 
        error: "Failed to write daily journal" 
      }, 500);
    }

    return c.json({ 
      success: true, 
      path: result.path,
      created: result.created
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ 
      success: false, 
      error: message 
    }, 500);
  }
});



// Inbound webhook — triggers a registered scheduler job by its webhook secret
// Register a webhook job via: register_schedule tool with action_type="agent_prompt"
// then set action_data to include a webhook_secret field.
app.post("/webhooks/:secret", async (c) => {
  const secret = c.req.param("secret");
  const dbPath = path.join(DATA_ROOT, "scheduler.db");
  let jobId: string | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    // Find job whose action_data contains this secret
    const jobs = db.prepare("SELECT * FROM jobs WHERE enabled = 1").all() as Array<Record<string, unknown>>;
    db.close();
    for (const job of jobs) {
      try {
        const d = JSON.parse(job.action_data as string);
        if (d.webhook_secret === secret) { jobId = job.id as string; break; }
      } catch { /* skip */ }
    }
  } catch { /* no DB yet */ }

  if (!jobId) return c.json({ error: "Unknown webhook" }, 404);

  const payload = await c.req.json().catch(() => ({}));
  const manager = globalThis.__majordomoManager;

  if (manager) {
    await manager.switchDomain("general");
    manager.sendMessage(
      `Webhook triggered (job: ${jobId})\n\nPayload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
    ).catch(() => {});
  }

  return c.json({ received: true, job: jobId });
});

// Webhook trigger by job ID — Phase 2 implementation
// POST /webhooks/jobs/:id to trigger a webhook-type job
app.post("/webhooks/jobs/:id", async (c) => {
  const jobId = c.req.param("id");
  const dbPath = path.join(DATA_ROOT, "scheduler.db");
  
  let job: Record<string, unknown> | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    job = db.prepare("SELECT * FROM jobs WHERE id = ? AND enabled = 1").get(jobId) as Record<string, unknown> | undefined;
    db.close();
  } catch (err) {
    return c.json({ error: "Scheduler database not available", details: String(err) }, 503);
  }

  if (!job) {
    return c.json({ error: "Job not found or disabled", job_id: jobId }, 404);
  }

  // Verify this is a webhook-type job
  const triggerType = (job.trigger_type as string) ?? 'cron';
  if (triggerType !== 'webhook') {
    return c.json({ error: "Job is not a webhook-triggered job", job_id: jobId, trigger_type: triggerType }, 400);
  }

  const payload = await c.req.json().catch(() => ({}));
  
  // Emit event for scheduler to execute the job
  webEvents.emit('webhook:trigger', { jobId, payload });

  // Record the trigger in runs table
  try {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO runs (job_id, ran_at, success) VALUES (?, datetime('now'), 1)").run(jobId);
    db.close();
  } catch {
    // Non-fatal if we can't record the run
  }

  return c.json({ triggered: true, job: jobId, payload });
});



// ── Server-Sent Events (real-time stream) ─────────────────────────────────────

app.get("/sse", (c) => {
  const domain = c.req.query("domain");
  const clientId = Math.random().toString(36).slice(2);

  const stream = new ReadableStream({
    start(controller) {
      wsClients.set(clientId, { id: clientId, controller, domain });
      console.log(`[web] SSE client connected: ${clientId} (domain: ${domain ?? "all"})`);

      // Send initial connection event
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ event: "connected", clientId })}\n\n`)
      );
    },
    cancel() {
      wsClients.delete(clientId);
      console.log(`[web] SSE client disconnected: ${clientId}`);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// ── Static SvelteKit frontend ─────────────────────────────────────────────────

// Serve PWA manifest and service worker (compiled binary or from disk)
app.get("/manifest.json", async (c) => {
  if (isCompiledBinary()) {
    return c.json(JSON.parse(manifest));
  }
  try {
    const content = await fs.readFile(path.join(STATIC_ROOT, "manifest.json"), "utf-8");
    return c.json(JSON.parse(content));
  } catch {
    return c.json({ error: "Manifest not found" }, 404);
  }
});

app.get("/sw.js", async (c) => {
  if (isCompiledBinary()) {
    return new Response(serviceWorker, {
      headers: { "Content-Type": "application/javascript" },
    });
  }
  try {
    const content = await fs.readFile(path.join(STATIC_ROOT, "sw.js"), "utf-8");
    return new Response(content, {
      headers: { "Content-Type": "application/javascript" },
    });
  } catch {
    return c.text("Service worker not found", 404);
  }
});

app.get("/apple-touch-icon.png", async (c) => {
  if (isCompiledBinary()) {
    return new Response(appleTouchIcon as unknown as BodyInit, {
      headers: { "Content-Type": "image/png" },
    });
  }
  try {
    const content = await fs.readFile(path.join(STATIC_ROOT, "apple-touch-icon.png"));
    return new Response(content, {
      headers: { "Content-Type": "image/png" },
    });
  } catch {
    return c.text("Icon not found", 404);
  }
});

// Serve static files from packages/web/static/ (built SvelteKit app)
// Only apply when NOT compiled binary (static files aren't on disk when compiled)
if (!isCompiledBinary()) {
  app.use("/*", serveStatic({ root: STATIC_ROOT }));
}

// SPA fallback — serve index.html for all unmatched routes
app.get("*", async (c) => {
  if (isCompiledBinary()) {
    return c.html(indexHTML);
  }
  try {
    const html = await fs.readFile(path.join(STATIC_ROOT, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("Majordomo Web — frontend not built yet. Run: bun run build in packages/web", 200);
  }
});

// ── Export for in-process use from service.ts ─────────────────────────────────

export { app, PORT, initializePlugins, websocketHandler };

// ── WebSocket PTY handler ────────────────────────────────────────────────────

interface TerminalWebSocket {
  shell?: ReturnType<typeof Bun.spawn>;
  send(message: string | ArrayBuffer): void;
  close(): void;
}

const terminalSockets = new Map<number, TerminalWebSocket>();
let socketIdCounter = 0;

const websocketHandler = {
  open(ws: TerminalWebSocket) {
    const socketId = ++socketIdCounter;
    terminalSockets.set(socketId, ws);

    // Spawn bash shell with PTY-like environment
    const shell = Bun.spawn(['bash', '-l'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...process.env,
      },
    });

    ws.shell = shell;

    // Pipe shell stdout to WebSocket
    (async () => {
      try {
        const reader = shell.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Send the ArrayBuffer underlying the Uint8Array
          ws.send(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
      } catch (err) {
        console.error('[term] stdout read error:', err);
      }
    })();

    // Pipe shell stderr to WebSocket
    (async () => {
      try {
        const reader = shell.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Send the ArrayBuffer underlying the Uint8Array
          ws.send(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }
      } catch (err) {
        console.error('[term] stderr read error:', err);
      }
    })();

    // Handle shell exit
    shell.exited.then(() => {
      terminalSockets.delete(socketId);
      try {
        ws.close();
      } catch { /* ignore */ }
    });

    console.log(`[term] Shell spawned for WebSocket #${socketId}`);
  },

  message(ws: TerminalWebSocket, message: string | Buffer) {
    if (!ws.shell || ws.shell.exitCode !== null) return;

    try {
      // Handle resize messages
      if (typeof message === 'string') {
        try {
          const data = JSON.parse(message);
          if (data.type === 'resize') {
            // Bun.spawn doesn't support PTY resize directly
            // We could use SIGWINCH but it's not critical for basic functionality
            return;
          }
        } catch {
          // Not JSON, treat as input
        }
      }

      // Pipe WebSocket messages to shell stdin
      if (ws.shell.stdin && typeof ws.shell.stdin !== 'number') {
        const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
        ws.shell.stdin.write(data);
      }
    } catch (err) {
      console.error('[term] stdin write error:', err);
    }
  },

  close(ws: TerminalWebSocket) {
    if (ws.shell) {
      try {
        ws.shell.kill();
      } catch { /* ignore */ }
    }
    console.log('[term] WebSocket closed');
  },
};

// ── Standalone entry (bun packages/web/src/server.ts) ────────────────────────

if (import.meta.main) {
  await initializePlugins();

  // Use Bun.serve for WebSocket support
  Bun.serve({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);
      
      // Upgrade /term to WebSocket
      if (url.pathname === '/term') {
        const upgraded = server.upgrade(req);
        if (upgraded) {
          return undefined; // WebSocket upgrade successful
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // Handle all other requests with Hono
      return app.fetch(req, { waitUntil: () => {} });
    },
    websocket: websocketHandler,
  });

  console.log(`🌐  Majordomo Web listening on http://localhost:${PORT}`);
}
