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
import { createLogger } from "../../agent/lib/logger.ts";

import { indexHTML, isCompiledBinary, manifest, serviceWorker, getAppleTouchIcon, getIcon512, reactIndexHTML, appJs, appCss } from "./assets.ts";
import { request as httpRequest } from "node:http";

// ── Logger ────────────────────────────────────────────────────────────────────

const logger = createLogger({ context: { component: "web-server" } });

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MAJORDOMO_WEB_PORT ?? "3000");
const PROJECT_ROOT = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
const HOME = process.env.HOME ?? "/root";
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");
const MEMORY_ROOT = path.join(MAJORDOMO_STATE, "memory");
const DATA_ROOT = path.join(MAJORDOMO_STATE, "data");
const STATIC_ROOT = path.join(import.meta.dirname, "..", "static");

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

// Track heartbeat timers for SSE controllers (type-safe cleanup)
const heartbeatTimers = new WeakMap<ReadableStreamDefaultController, NodeJS.Timeout>();

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
// Phase 1: Forward full message state (parallel to existing delta events)
webEvents.on("agent:message_update", (data: { domain: string; message: any }) => {
  broadcast("agent:message_update", data, data.domain);
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
const CORRUPTION_STATS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Remove corruption stats older than 7 days to prevent unbounded memory growth.
 * Called automatically when new corruption is detected.
 */
function pruneCorruptionStats(): void {
  const now = Date.now();
  const expiredKeys: string[] = [];
  
  for (const [key, stats] of corruptionStats.entries()) {
    const lastTimestamp = stats.lastCorruptionTimestamp ?? 0;
    if (now - lastTimestamp > CORRUPTION_STATS_TTL) {
      expiredKeys.push(key);
    }
  }
  
  for (const key of expiredKeys) {
    corruptionStats.delete(key);
  }
  
  if (expiredKeys.length > 0) {
    logger.info("Pruned stale corruption entries", { pruned: expiredKeys.length, ttl: "7 days" });
  }
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
 * Remove cache entries that have exceeded TTL.
 * Prevents memory leak from domains accessed once and never again.
 */
function pruneExpiredCache(): void {
  const now = Date.now();
  const expiredKeys: string[] = [];
  
  for (const [key, cached] of messageCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL) {
      expiredKeys.push(key);
    }
  }
  
  for (const key of expiredKeys) {
    messageCache.delete(key);
  }
  
  if (expiredKeys.length > 0) {
    logger.info("Pruned expired cache entries", { pruned: expiredKeys.length });
  }
}

// Periodic cleanup to prevent unbounded growth
// Runs every 60 seconds to remove expired entries
const cacheCleanupInterval = setInterval(() => {
  pruneExpiredCache();
}, 60000);

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
    
    // Prune stale corruption stats to prevent unbounded growth
    pruneCorruptionStats();
    
    // Keep limited examples
    if (stats.examples.length < MAX_CORRUPTION_EXAMPLES) {
      stats.examples.push({
        lineNumber: lineNumber ?? -1,
        preview,
        error: errorMessage,
      });
    }
    
    // Log warning with context
    logger.warn("Malformed JSONL line detected", {
      sessionFile: sessionFile || domain,
      domain,
      lineNumber: lineNumber ?? -1,
      error: errorMessage,
      preview,
    });
    
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

// ── Widget compute functions ────────────────────────────────────────────────────

// ── Container management (Docker/Incus) ───────────────────────────────────────

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  ports: string[];
  runtime: "docker" | "incus";
}

async function unixRequest(
  socketPath: string,
  path: string,
  method = "GET",
  body?: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const DOCKER_SOCK = "/var/run/docker.sock";
const INCUS_SOCK = "/var/lib/incus/unix.socket";

async function listDockerContainers(): Promise<ContainerInfo[]> {
  try {
    const data = await unixRequest(DOCKER_SOCK, "/containers/json?all=1") as Array<Record<string, unknown>>;
    return data.map((c) => {
      const names = (c.Names as string[]) ?? [];
      const ports = ((c.Ports as Array<{ PublicPort?: number; PrivatePort: number; Type: string }>) ?? [])
        .filter((p) => p.PublicPort)
        .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`);
      return {
        id: (c.Id as string).slice(0, 12),
        name: names[0]?.replace(/^\//, "") ?? "unknown",
        image: c.Image as string,
        status: c.Status as string,
        running: c.State === "running",
        ports,
        runtime: "docker",
      };
    });
  } catch {
    return [];
  }
}

async function listIncusContainers(): Promise<ContainerInfo[]> {
  try {
    const data = await unixRequest(INCUS_SOCK, "/1.0/instances?recursion=1") as {
      metadata: Array<{ name: string; status: string; type: string; description: string }>;
    };
    return (data.metadata ?? []).map((inst) => ({
      id: inst.name,
      name: inst.name,
      image: inst.description || inst.type,
      status: inst.status,
      running: inst.status.toLowerCase() === "running",
      ports: [],
      runtime: "incus",
    }));
  } catch {
    return [];
  }
}

async function listAllContainers(): Promise<ContainerInfo[]> {
  const [docker, incus] = await Promise.all([
    listDockerContainers(),
    listIncusContainers(),
  ]);
  return [...docker, ...incus].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function dockerAction(id: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  try {
    await unixRequest(DOCKER_SOCK, `/containers/${id}/${action}`, "POST");
    return true;
  } catch {
    return false;
  }
}

async function incusAction(name: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  try {
    await unixRequest(
      INCUS_SOCK,
      `/1.0/instances/${name}/state`,
      "PUT",
      JSON.stringify({ action, timeout: 30 })
    );
    return true;
  } catch {
    return false;
  }
}

async function computeContainersWidget(): Promise<unknown> {
  const containers = await listAllContainers();
  return {
    containers,
    updatedAt: Date.now(),
    meta: {
      total: containers.length,
      running: containers.filter(c => c.running).length,
    },
  };
}

// ── Priorities widget ─────────────────────────────────────────────────────────

interface PriorityItem {
  domain: string;
  task: string;
  priority: string;
  due?: string;
}

async function computePriorities(): Promise<PriorityItem[]> {
  const domains = await readDomains();
  const priorities: PriorityItem[] = [];

  for (const domain of domains) {
    try {
      const content = await fs.readFile(path.join(MEMORY_ROOT, domain.path, "action-items.md"), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.startsWith("- [ ]")) continue;
        const taskText = line.slice(5).split(" | ")[0].trim();
        const priMatch = line.match(/\bpri:(critical|high|med|low)\b/);
        const dueMatch = line.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/);
        const priority = priMatch?.[1] ?? "med";
        if (priority === "critical" || priority === "high") {
          priorities.push({ domain: domain.id, task: taskText, priority, due: dueMatch?.[1] });
        }
      }
    } catch { /* domain may not have action-items */ }
  }

  const order = { critical: 0, high: 1, med: 2, low: 3 };
  return priorities.sort((a, b) => {
    const po = (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2);
    if (po !== 0) return po;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    return a.due ? -1 : b.due ? 1 : 0;
  });
}

async function computePrioritiesWidget(): Promise<unknown> {
  const items = await computePriorities();
  return {
    items,
    updatedAt: Date.now(),
    meta: {
      total: items.length,
      critical: items.filter(i => i.priority === "critical").length,
      high: items.filter(i => i.priority === "high").length,
    },
  };
}

async function markPriorityDone(domain: string, task: string): Promise<{ ok: boolean; error?: string }> {
  const filePath = path.join(MEMORY_ROOT, domain, "action-items.md");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const updated = content.replace(new RegExp(`^- \\[ \\] ${escaped}`, "m"), `- [x] ${task} (done ${new Date().toISOString().slice(0, 10)})`);
    if (updated === content) return { ok: false, error: "Task not found" };
    await fs.writeFile(filePath, updated);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Subagents widget ──────────────────────────────────────────────────────────

async function computeSubagentsWidget(): Promise<unknown> {
  const dbPath = path.join(DATA_ROOT, "subagents.db");
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT * FROM runs ORDER BY started_at DESC LIMIT 50"
    ).all() as Array<Record<string, unknown>>;
    db.close();
    
    const runs = rows.map(r => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      provider: r.provider ?? null,
      model: r.model ?? null,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
      retries: r.retries,
      outputPreview: r.output ? String(r.output).slice(0, 200) : null,
      error: r.error ?? null,
    }));
    
    return { 
      runs, 
      updatedAt: Date.now(),
      meta: {
        total: runs.length,
        completed: runs.filter(r => r.status === 'done').length,
        failed: runs.filter(r => r.status === 'failed').length,
      },
    };
  } catch (err) {
    logger.error("Failed to query subagents database", err instanceof Error ? err : { error: String(err) });
    return { 
      runs: [], 
      updatedAt: Date.now(),
      meta: { error: String(err) },
    };
  }
}

// ── Schedules widget ──────────────────────────────────────────────────────────

async function computeSchedulesWidget(): Promise<unknown> {
  const dbPath = path.join(DATA_ROOT, "scheduler.db");
  try {
    const db = new Database(dbPath, { readonly: true });
    const jobs = db.prepare(`
      SELECT j.id, j.cron, j.action_type, j.action_data, j.enabled,
             MAX(r.ran_at) as last_ran, SUM(CASE WHEN r.success=1 THEN 1 ELSE 0 END) as run_count
      FROM jobs j
      LEFT JOIN runs r ON j.id = r.job_id
      GROUP BY j.id
      ORDER BY j.id
    `).all() as Array<Record<string, unknown>>;
    db.close();

    return {
      jobs: jobs.map(j => ({
        id: j.id,
        cron: j.cron,
        action: (() => {
          try { const d = JSON.parse(j.action_data as string); return d.command ?? d.message ?? String(j.action_data); }
          catch { return String(j.action_data); }
        })(),
        enabled: Boolean(j.enabled),
        lastRan: j.last_ran ?? null,
        runCount: j.run_count ?? 0,
      })),
      updatedAt: Date.now(),
      meta: { total: jobs.length, enabled: jobs.filter(j => j.enabled).length },
    };
  } catch (err) {
    return { jobs: [], updatedAt: Date.now(), meta: { error: String(err) } };
  }
}

// ── Workflows widget ──────────────────────────────────────────────────────────

interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  step_id: string;
  agent: string;
  status: string;
  input?: string;
  output?: string;
  error?: string;
  started_at?: number;
  finished_at?: number;
  iteration_index?: number;
  iteration_total?: number;
  created_at: number;
}

interface WorkflowStep {
  id: string;
  stepId: string;
  agent: string;
  status: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  iterationIndex: number | null;
  iterationTotal: number | null;
}

interface WorkflowSummary {
  workflowId: string;
  workflowName: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  steps: WorkflowStep[];
}

async function computeWorkflowsWidget(): Promise<unknown> {
  const dbPath = path.join(DATA_ROOT, "subagents.db");
  try {
    const db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA foreign_keys = ON");
    
    const maxWorkflows = 10;
    
    const workflows = db.prepare(`
      SELECT DISTINCT workflow_id, workflow_name, MIN(created_at) as created_at
      FROM workflow_steps
      GROUP BY workflow_id
      ORDER BY created_at DESC
      LIMIT ?
    `).all(maxWorkflows) as Array<{ workflow_id: string; workflow_name: string; created_at: number }>;
    
    const workflowSummaries: WorkflowSummary[] = workflows.map(w => {
      const steps = db.prepare(
        "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY created_at ASC"
      ).all(w.workflow_id) as WorkflowStepRow[];
      
      const completed = steps.filter(s => s.status === 'done').length;
      const failed = steps.filter(s => s.status === 'failed').length;
      const running = steps.filter(s => s.status === 'running' || s.status === 'pending').length;
      
      let status: 'running' | 'done' | 'failed' = 'done';
      if (running > 0) status = 'running';
      else if (failed > 0) status = 'failed';
      
      return {
        workflowId: w.workflow_id,
        workflowName: w.workflow_name,
        totalSteps: steps.length,
        completedSteps: completed,
        failedSteps: failed,
        status,
        createdAt: w.created_at,
        steps: steps.map(s => ({
          id: s.id,
          stepId: s.step_id,
          agent: s.agent,
          status: s.status,
          error: s.error ?? null,
          startedAt: s.started_at ?? null,
          finishedAt: s.finished_at ?? null,
          iterationIndex: s.iteration_index ?? null,
          iterationTotal: s.iteration_total ?? null,
        })),
      };
    });
    
    db.close();
    
    return { 
      workflows: workflowSummaries,
      updatedAt: Date.now(),
      meta: {
        total: workflowSummaries.length,
        running: workflowSummaries.filter(w => w.status === 'running').length,
        failed: workflowSummaries.filter(w => w.status === 'failed').length,
      },
    };
  } catch (err) {
    logger.error("Failed to query workflows database", err instanceof Error ? err : { error: String(err) });
    return { 
      workflows: [], 
      updatedAt: Date.now(),
      meta: { error: String(err) },
    };
  }
}

// ── Widget data getter ────────────────────────────────────────────────────────

async function getWidgetData(name: string): Promise<unknown> {
  switch (name) {
    case "priorities":
      return await computePrioritiesWidget();
    case "containers":
      return await computeContainersWidget();
    case "subagents":
      return await computeSubagentsWidget();
    case "schedules":
      return await computeSchedulesWidget();
    case "workflows":
      return await computeWorkflowsWidget();
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

// Health
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// Session health check — scans for corrupted sessions
app.get("/api/health/sessions", async (c) => {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("GET /api/health/sessions failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to check session health", details: message }, 500);
  }
});

// Reset corruption stats (for testing/recovery)
app.post("/api/health/sessions/reset", (c) => {
  try {
    corruptionStats.clear();
    return c.json({ success: true, message: "Corruption stats reset" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/health/sessions/reset failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to reset corruption stats", details: message }, 500);
  }
});

// Cleanup stale corruption stats (older than 7 days)
app.post("/api/health/sessions/cleanup", (c) => {
  try {
    const beforeCount = corruptionStats.size;
    pruneCorruptionStats();
    const afterCount = corruptionStats.size;
    const removed = beforeCount - afterCount;
    
    return c.json({ 
      success: true, 
      message: `Cleaned up ${removed} stale corruption entries`, 
      beforeCount,
      afterCount,
      removed
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/health/sessions/cleanup failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to cleanup corruption stats", details: message }, 500);
  }
});

// ── Domains API ───────────────────────────────────────────────────────────────

app.get("/api/domains", async (c) => {
  try {
    const domains = await readDomains();
    const manager = globalThis.__majordomoManager;
    return c.json({ domains, activeDomain: manager?.getDomain() ?? "general" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("GET /api/domains failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to fetch domains", details: message }, 500);
  }
});

app.post("/api/domains/:id/activate", async (c) => {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/domains/:id/activate failed", err instanceof Error ? err : { error: message });
    return c.json({ success: false, error: "Failed to activate domain", details: message }, 500);
  }
});

// ── Messages API ──────────────────────────────────────────────────────────────

app.get("/api/messages/:domain", async (c) => {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("GET /api/messages/:domain failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to fetch messages", details: message }, 500);
  }
});

// POST a message to a domain (web UI → agent)
app.post("/api/messages/:domain", async (c) => {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/messages/:domain failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to send message", details: message }, 500);
  }
});

// ── Subagent Session API ──────────────────────────────────────────────────────

// Get list of subagent runs
app.get("/api/subagents", async (c) => {
  const dbPath = path.join(DATA_ROOT, "subagents.db");
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT id, agent, status, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT 50"
    ).all() as Array<Record<string, unknown>>;
    db.close();
    
    const runs = rows.map(r => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
    }));
    
    return c.json({ runs });
  } catch (err) {
    logger.error("Failed to list subagent runs", err instanceof Error ? err : { error: String(err) });
    return c.json({ error: "Failed to list runs" }, 500);
  }
});

// Get full session JSONL for a completed run
app.get("/api/subagents/:id/session", async (c) => {
  const { id } = c.req.param();
  const dbPath = path.join(DATA_ROOT, "subagents.db");
  
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT session_jsonl, status FROM runs WHERE id = ?")
      .get(id) as { session_jsonl: string | null; status: string } | null;
    db.close();
    
    if (!row) {
      return c.json({ error: "Run not found" }, 404);
    }
    
    if (!row.session_jsonl) {
      return c.json({ error: "Session data not available for this run" }, 404);
    }
    
    return c.json({ 
      runId: id, 
      status: row.status,
      jsonl: row.session_jsonl 
    });
  } catch (err) {
    logger.error("Failed to fetch session", { runId: id, error: err });
    return c.json({ error: "Database error" }, 500);
  }
});

// SSE stream for live or historical session
app.get("/api/subagents/:id/stream", async (c) => {
  const { id } = c.req.param();
  const streamsDir = path.join(DATA_ROOT, "subagent-streams");
  const streamPath = path.join(streamsDir, `${id}.jsonl`);
  
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      
      // Check if run is still active (temp file exists)
      let isLive = false;
      try {
        await fs.access(streamPath);
        isLive = true;
      } catch {
        // File doesn't exist — check DB for completed run
      }
      
      if (isLive) {
        // Tail live file
        let position = 0;
        const interval = setInterval(async () => {
          try {
            const stats = await fs.stat(streamPath).catch(() => null);
            if (!stats) {
              // File was deleted, run completed
              clearInterval(interval);
              controller.close();
              return;
            }
            
            const content = await fs.readFile(streamPath, "utf-8");
            const newData = content.slice(position);
            if (newData) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ events: newData })}\n\n`));
              position = content.length;
            }
          } catch (err) {
            clearInterval(interval);
            controller.close();
          }
        }, 500);  // Poll every 500ms
        
      } else {
        // Serve from DB
        const dbPath = path.join(DATA_ROOT, "subagents.db");
        try {
          const db = new Database(dbPath, { readonly: true });
          const row = db.prepare("SELECT session_jsonl FROM runs WHERE id = ?")
            .get(id) as { session_jsonl: string | null } | null;
          db.close();
          
          if (row?.session_jsonl) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ events: row.session_jsonl })}\n\n`));
          }
        } catch (err) {
          logger.error("Failed to read session from DB", { runId: id, error: err });
        }
        controller.close();
      }
    },
  });
  
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ── Widgets API ───────────────────────────────────────────────────────────────

app.get("/api/widgets/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const data = await getWidgetData(name);
    if (data === null) return c.json({ error: "Widget not found" }, 404);
    return c.json({ widget: name, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("GET /api/widgets/:name failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to fetch widget data", details: message }, 500);
  }
});

// Widget action routes
app.post("/api/priorities/done", async (c) => {
  try {
    const { domain, task } = await c.req.json();
    if (!domain || !task) return c.json({ error: "domain and task required" }, 400);
    if (!isValidDomainId(domain)) return c.json({ error: "Invalid domain ID format" }, 400);
    const result = await markPriorityDone(domain, task);
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/priorities/done failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to mark priority done", details: message }, 500);
  }
});

app.post("/api/containers/:runtime/:id/:action", async (c) => {
  try {
    const { runtime, id, action } = c.req.param();
    
    if (!["start", "stop", "restart"].includes(action)) {
      return c.json({ error: "Invalid action" }, 400);
    }
    
    const act = action as "start" | "stop" | "restart";
    let ok = false;
    
    if (runtime === "docker") {
      ok = await dockerAction(id, act);
    } else if (runtime === "incus") {
      ok = await incusAction(id, act);
    } else {
      return c.json({ error: "Unknown runtime" }, 400);
    }
    
    return c.json({ ok });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/containers/:runtime/:id/:action failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to control container", details: message }, 500);
  }
});

app.post("/api/schedules/:id/trigger", async (c) => {
  try {
    const jobId = c.req.param("id");
    const manager = globalThis.__majordomoManager;

    if (!manager) return c.json({ error: "Agent not available" }, 503);

    const dbPath = path.join(DATA_ROOT, "scheduler.db");
    try {
      const db = new Database(dbPath, { readonly: true });
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
      db.close();

      if (!job) return c.json({ error: "Job not found" }, 404);

      const data = JSON.parse(job.action_data as string);
      let msg: string;

      if (job.action_type === "pi_command") {
        const cmd = data.command as string;
        const skillMatch = cmd.match(/^\/cog-(\w+)$/);
        if (skillMatch) {
          const projectRoot = (process.env.MAJORDOMO_HOME
            ? path.join(process.env.MAJORDOMO_HOME, "current")
            : process.cwd());
          const skillFile = path.join(projectRoot, ".claude", "commands", `${skillMatch[1]}.md`);
          try {
            const instructions = await fs.readFile(skillFile, "utf-8");
            msg = `Please execute the following COG pipeline skill. Memory root: \`${path.join(MAJORDOMO_STATE, "memory")}\`\n\n---\n\n${instructions}`;
          } catch {
            msg = cmd;
          }
        } else {
          msg = cmd;
        }
      } else {
        msg = data.message;
      }

      manager.sendMessage(msg).catch((err) => {
        logger.error("Scheduled trigger sendMessage failed", err instanceof Error ? err : { error: String(err) });
      });
      return c.json({ triggered: true, job: jobId });
    } catch (err) {
      logger.error("Failed to trigger scheduled job", err instanceof Error ? err : { error: String(err) });
      return c.json({ error: String(err) }, 500);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /api/schedules/:id/trigger failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to trigger schedule", details: message }, 500);
  }
});

// Return empty plugins list for backward compatibility
app.get("/api/plugins", (c) => {
  return c.json({ plugins: [] });
});

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
  try {
    const secret = c.req.param("secret");
    const dbPath = path.join(DATA_ROOT, "scheduler.db");
    let jobId: string | undefined;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        // Find job whose action_data contains this secret
        const jobs = db.prepare("SELECT * FROM jobs WHERE enabled = 1").all() as Array<Record<string, unknown>>;
        for (const job of jobs) {
          try {
            const d = JSON.parse(job.action_data as string);
            if (d.webhook_secret === secret) { jobId = job.id as string; break; }
          } catch { /* skip */ }
        }
      } finally {
        db.close();
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /webhooks/:secret failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to process webhook", details: message }, 500);
  }
});

// Webhook trigger by job ID — Phase 2 implementation
// POST /webhooks/jobs/:id to trigger a webhook-type job
app.post("/webhooks/jobs/:id", async (c) => {
  try {
    const jobId = c.req.param("id");
    const dbPath = path.join(DATA_ROOT, "scheduler.db");
    
    let job: Record<string, unknown> | undefined;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        job = db.prepare("SELECT * FROM jobs WHERE id = ? AND enabled = 1").get(jobId) as Record<string, unknown> | undefined;
      } finally {
        db.close();
      }
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
      try {
        db.prepare("INSERT INTO runs (job_id, ran_at, success) VALUES (?, datetime('now'), 1)").run(jobId);
      } finally {
        db.close();
      }
    } catch {
      // Non-fatal if we can't record the run
    }

    return c.json({ triggered: true, job: jobId, payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("POST /webhooks/jobs/:id failed", err instanceof Error ? err : { error: message });
    return c.json({ error: "Failed to trigger webhook job", details: message }, 500);
  }
});



// ── Server-Sent Events (real-time stream) ─────────────────────────────────────

app.get("/sse", (c) => {
  const domain = c.req.query("domain");
  const clientId = Math.random().toString(36).slice(2);

  const stream = new ReadableStream({
    start(controller) {
      wsClients.set(clientId, { id: clientId, controller, domain });
      logger.info("SSE client connected", { clientId, domain: domain ?? "all" });

      // Send initial connection event
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ event: "connected", clientId })}\n\n`)
      );

      // Heartbeat every 15s to keep HTTP/2 streams alive through Tailscale proxy
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      // Store heartbeat ref for cleanup (type-safe via WeakMap)
      heartbeatTimers.set(controller, heartbeat);
    },
    cancel() {
      const client = wsClients.get(clientId);
      if (client) {
        const heartbeat = heartbeatTimers.get(client.controller);
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeatTimers.delete(client.controller);
        }
      }
      wsClients.delete(clientId);
      logger.info("SSE client disconnected", { clientId });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",  // disable nginx/proxy buffering
      // Note: Connection: keep-alive is HTTP/1.1 only; omit for HTTP/2 compat
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
  try {
    // Always read from STATIC_ROOT — works in both compiled and dev mode
    const content = await fs.readFile(path.join(STATIC_ROOT, "apple-touch-icon.png"));
    return new Response(content, { headers: { "Content-Type": "image/png" } });
  } catch {
    return c.text("Icon not found", 404);
  }
});

app.get("/icon-512.png", async (c) => {
  try {
    const content = await fs.readFile(path.join(STATIC_ROOT, "icon-512.png"));
    return new Response(content, { headers: { "Content-Type": "image/png" } });
  } catch {
    return c.text("Icon not found", 404);
  }
});

// ── React App (default UI) + classic fallback ────────────────────────────────

// React is the default UI
app.get("/", async (c) => {
  if (isCompiledBinary()) {
    return c.html(reactIndexHTML);
  }
  try {
    const html = await fs.readFile(path.join(import.meta.dirname, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("React frontend not built yet. Run: bun run build:client", 200);
  }
});

// /react alias
app.get("/react", async (c) => {
  if (isCompiledBinary()) {
    return c.html(reactIndexHTML);
  }
  try {
    const html = await fs.readFile(path.join(import.meta.dirname, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("React frontend not built yet. Run: bun run build:client", 200);
  }
});

// Legacy vanilla JS UI at /classic
app.get("/classic", async (c) => {
  if (isCompiledBinary()) {
    return c.html(indexHTML);
  }
  try {
    const html = await fs.readFile(path.join(STATIC_ROOT, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("Classic UI not found", 404);
  }
});

// Serve React bundled JS
app.get("/app.js", async (c) => {
  if (isCompiledBinary()) {
    return new Response(appJs, {
      headers: { "Content-Type": "application/javascript" },
    });
  }
  try {
    const file = path.join(import.meta.dirname, "..", "dist", "app.js");
    const content = await fs.readFile(file, "utf-8");
    return new Response(content, {
      headers: { "Content-Type": "application/javascript" },
    });
  } catch {
    return c.text("app.js not found. Run: bun run build:client", 404);
  }
});

// Serve React bundled CSS
app.get("/app.css", async (c) => {
  if (isCompiledBinary()) {
    return new Response(appCss, {
      headers: { "Content-Type": "text/css" },
    });
  }
  try {
    const file = path.join(import.meta.dirname, "..", "dist", "app.css");
    const content = await fs.readFile(file, "utf-8");
    return new Response(content, {
      headers: { "Content-Type": "text/css" },
    });
  } catch {
    return c.text("app.css not found. Run: bun run build:client", 404);
  }
});

// Serve static files from packages/web/static/ (for /classic route assets)
// Only apply when NOT compiled binary (static files aren't on disk when compiled)
if (!isCompiledBinary()) {
  app.use("/classic/*", serveStatic({ root: STATIC_ROOT, rewriteRequestPath: (path) => path.replace(/^\/classic/, '') }));
}

// SPA fallback — serve React index.html for unmatched non-API routes
app.get("*", async (c) => {
  // Don't catch API routes — return 404 so they fail clearly
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/plugins/')) {
    return c.json({ error: 'Not found' }, 404);
  }
  if (isCompiledBinary()) {
    return c.html(reactIndexHTML);
  }
  try {
    const html = await fs.readFile(path.join(import.meta.dirname, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("Majordomo Web — React frontend not built yet. Run: bun run build:client in packages/web", 200);
  }
});

// ── Export for in-process use from service.ts ─────────────────────────────────

export { app, PORT, websocketHandler };

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

    // Spawn bash via python3 pty.spawn — creates a real PTY so bash shows prompts
    // Bun.spawn alone doesn't allocate a PTY, so bash runs non-interactively without one
    const shell = Bun.spawn(['python3', '-c', 'import pty,os; os.environ["TERM"]="xterm-256color"; pty.spawn(["/bin/bash","-l"])'], {
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
        logger.error("Terminal stdout read error", err instanceof Error ? err : { error: String(err) });
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
        logger.error("Terminal stderr read error", err instanceof Error ? err : { error: String(err) });
      }
    })();

    // Handle shell exit
    shell.exited.then(() => {
      terminalSockets.delete(socketId);
      try {
        ws.close();
      } catch { /* ignore */ }
    });

    logger.info("Shell spawned for WebSocket", { socketId });
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
      logger.error("Terminal stdin write error", err instanceof Error ? err : { error: String(err) });
    }
  },

  close(ws: TerminalWebSocket) {
    if (ws.shell) {
      try {
        ws.shell.kill();
      } catch { /* ignore */ }
    }
    logger.info("Terminal WebSocket closed");
  },
};

// ── Standalone entry (bun packages/web/src/server.ts) ────────────────────────

if (import.meta.main) {

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

  logger.info(`Majordomo Web listening on http://localhost:${PORT}`, { port: PORT });
}
