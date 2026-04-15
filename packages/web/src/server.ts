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
import { serve } from "@hono/node-server";
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

function parseMessageEntry(line: string, domain: string, isUnifiedHistory: boolean, messages: SessionTimelineItem[], toolCallIndex: Map<string, number>): void {
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
  } catch { /* skip malformed lines */ }
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
    parseMessageEntry(lines[i], domain, isUnifiedHistory, messages, toolCallIndex);
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

// Load and register plugins at startup
loadedPlugins = await loadPlugins(PLUGIN_DIR);
registerPlugins(app, loadedPlugins, { dataRoot: DATA_ROOT, webEvents });

// Health
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

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

export { app, PORT };

// ── Standalone entry (bun packages/web/src/server.ts) ────────────────────────

if (import.meta.main) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`🌐  Majordomo Web listening on http://localhost:${info.port}`);
  });
}
