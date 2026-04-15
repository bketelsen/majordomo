/**
 * Subagent Manager Extension
 *
 * Spawns isolated pi agent processes for specialist tasks.
 * Leverages pi's built-in subagent infrastructure (--mode json -p --no-session)
 * but adds:
 *   - YAML frontmatter agent registry loaded from agents/*.md
 *   - Async run tracking via subagents.db
 *   - Completion notifications pushed to the main session via pi.events
 *   - Schema validation on input and output
 *   - retry / report_to_majordomo failure handling
 *
 * Tools registered:
 *   spawn_subagent  — run a named agent with structured input
 *   list_agents     — show available agent definitions
 *   subagent_status — check status of a running or completed agent run
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { Database } from "bun:sqlite";
import { type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readDomainsManifest } from "../../../shared/lib/domains";
import { loadYamlFile } from "../../../shared/lib/yaml-helpers";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger({ context: { component: "subagent-manager" } });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubagentManagerOptions {
  projectRoot: string;
  agentsDir: string;     // path to agents/*.md
  workflowsDir?: string; // path to workflows/*.yaml (falls back to projectRoot/workflows)
  dataRoot: string;
  memoryRoot: string;    // path to memory/ for domain workingDir lookup
  maxConcurrency?: number;
  getDomain: () => string;  // Dynamic domain accessor
}

interface AgentDefinition {
  name: string;
  label: string;
  model?: { provider?: string; id?: string; thinking?: string };
  tools?: string[];
  cog_domain?: string | null;
  max_turns?: number;
  timeout_minutes?: number;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  on_failure?: { retry?: number; then?: string };
  systemPrompt: string; // from the markdown body
}

interface WorkflowStep {
  id: string;
  agent: string;
  depends_on?: string;
  iterate_over?: string;
  input: Record<string, string>;
}

interface RunRecord {
  id: string;
  agent: string;
  status: "running" | "done" | "failed";
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  stderr?: string;
  provider?: string;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  retries: number;
}

interface WorkflowStep {
  id: string;
  agent: string;
  depends_on?: string;
  iterate_over?: string;
  input: Record<string, string>;
}

interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  agent: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  input?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  iterationIndex?: number;
  iterationTotal?: number;
  createdAt: number;
}

// ── Agent registry ────────────────────────────────────────────────────────────

async function loadAgents(agentsDir: string): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(agentsDir);
  } catch (err) {
    logger.debug("Agents directory not found", { agentsDir, error: err });
    return agents;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await fs.readFile(path.join(agentsDir, file), "utf-8");
      const agent = parseAgentFile(content);
      if (agent) agents.push(agent);
    } catch (err) {
      logger.warn("Failed to load agent file", { file, error: err });
    }
  }

  return agents;
}

function parseAgentFile(content: string): AgentDefinition | null {
  // Extract YAML frontmatter between --- markers
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const meta = yaml.load(match[1]) as Record<string, unknown>;
    const systemPrompt = match[2].trim();

    return {
      name: String(meta.name ?? ""),
      label: String(meta.label ?? meta.name ?? ""),
      model: meta.model as AgentDefinition["model"],
      tools: meta.tools as string[],
      cog_domain: meta.cog_domain as string | null,
      max_turns: meta.max_turns as number | undefined,
      timeout_minutes: meta.timeout_minutes as number | undefined,
      input_schema: meta.input_schema as Record<string, unknown>,
      output_schema: meta.output_schema as Record<string, unknown>,
      on_failure: meta.on_failure as AgentDefinition["on_failure"],
      systemPrompt,
    };
  } catch (err) {
    logger.debug("Failed to parse agent definition", { preview: content.slice(0, 100), error: err });
    return null;
  }
}

// ── Run tracking (SQLite-backed) ─────────────────────────────────────────────

function openRunsDb(dataRoot: string): Database {  const db = new Database(path.join(dataRoot, "subagents.db"));
  
  // Enable foreign key constraints
  db.exec("PRAGMA foreign_keys = ON");
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      input       TEXT NOT NULL,
      output      TEXT,
      error       TEXT,
      stderr      TEXT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      retries     INTEGER NOT NULL DEFAULT 0
    );
    -- Additive migration: add stderr column if it doesn't exist (safe on repeat runs)
    CREATE TABLE IF NOT EXISTS runs_migration_check (dummy INTEGER);
  `);
  // Add stderr column idempotently (ALTER TABLE throws if column exists in SQLite)
  try { db.exec(`ALTER TABLE runs ADD COLUMN stderr TEXT`); } catch (err) {
    logger.debug("stderr column already exists in runs table", { error: err });
  }
  // Add provider and model columns idempotently
  try { db.exec(`ALTER TABLE runs ADD COLUMN provider TEXT`); } catch (err) {
    logger.debug("provider column already exists in runs table", { error: err });
  }
  try { db.exec(`ALTER TABLE runs ADD COLUMN model TEXT`); } catch (err) {
    logger.debug("model column already exists in runs table", { error: err });
  }

  // Create workflow_steps table
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id              TEXT PRIMARY KEY,
      workflow_id     TEXT NOT NULL,
      workflow_name   TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      agent           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      input           TEXT,
      output          TEXT,
      error           TEXT,
      started_at      INTEGER,
      finished_at     INTEGER,
      iteration_index INTEGER,
      iteration_total INTEGER,
      created_at      INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow 
      ON workflow_steps(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_status 
      ON workflow_steps(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_created 
      ON workflow_steps(created_at DESC);
  `);

  // Mark any runs still 'running' from a previous process as orphaned
  const orphaned = db.prepare(
    "UPDATE runs SET status = 'failed', error = 'Orphaned: service restarted before completion', finished_at = ? WHERE status = 'running'"
  ).run(Date.now());
  if ((orphaned.changes as number) > 0) {
    logger.info("Marked orphaned runs as failed", { count: orphaned.changes });
  }
  
  // Mark orphaned workflow steps as failed
  const orphanedSteps = db.prepare(
    "UPDATE workflow_steps SET status = 'failed', error = 'Orphaned: service restarted', finished_at = ? WHERE status IN ('pending', 'running')"
  ).run(Date.now());
  if ((orphanedSteps.changes as number) > 0) {
    logger.info("Marked orphaned workflow steps as failed", { count: orphanedSteps.changes });
  }

  // Clean up old completed workflow steps (>30 days)
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const cleanedSteps = db.prepare(
    "DELETE FROM workflow_steps WHERE created_at < ? AND status IN ('done', 'failed', 'skipped')"
  ).run(thirtyDaysAgo);
  if ((cleanedSteps.changes as number) > 0) {
    logger.info("Cleaned up old workflow steps", { count: cleanedSteps.changes, olderThan: "30 days" });
  }

  return db;
}

function createRun(db: Database, agent: string, input: Record<string, unknown>, provider?: string, model?: string): RunRecord {
  const id = `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO runs (id, agent, status, input, provider, model, started_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?)
  `).run(id, agent, JSON.stringify(input), provider ?? null, model ?? null, Date.now());
  return { id, agent, status: "running", input, provider, model, startedAt: Date.now(), retries: 0 };
}

function updateRun(db: Database, id: string, fields: Partial<Pick<RunRecord, 'status' | 'output' | 'error' | 'stderr' | 'retries' | 'finishedAt'>>): void {
  if (fields.status !== undefined) {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(fields.status, id);
  }
  if (fields.output !== undefined) {
    db.prepare("UPDATE runs SET output = ? WHERE id = ?").run(fields.output, id);
  }
  if (fields.error !== undefined) {
    db.prepare("UPDATE runs SET error = ? WHERE id = ?").run(fields.error, id);
  }
  if (fields.stderr !== undefined) {
    db.prepare("UPDATE runs SET stderr = ? WHERE id = ?").run(fields.stderr, id);
  }
  if (fields.retries !== undefined) {
    db.prepare("UPDATE runs SET retries = ? WHERE id = ?").run(fields.retries, id);
  }
  if (fields.finishedAt !== undefined) {
    db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(fields.finishedAt, id);
  }
}

function getRun(db: Database, id: string): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as string,
    agent: row.agent as string,
    status: row.status as RunRecord["status"],
    input: JSON.parse(row.input as string),
    output: row.output as string | undefined,
    error: row.error as string | undefined,
    stderr: row.stderr as string | undefined,
    provider: row.provider as string | undefined,
    model: row.model as string | undefined,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | undefined,
    retries: row.retries as number,
  };
}

function getRecentRuns(db: Database, limit = 10): RunRecord[] {
  const rows = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    agent: row.agent as string,
    status: row.status as RunRecord["status"],
    input: JSON.parse(row.input as string),
    output: row.output as string | undefined,
    error: row.error as string | undefined,
    stderr: row.stderr as string | undefined,
    provider: row.provider as string | undefined,
    model: row.model as string | undefined,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | undefined,
    retries: row.retries as number,
  }));
}

// ── Workflow step tracking ────────────────────────────────────────────────────

function createWorkflowStep(
  db: Database,
  workflowId: string,
  workflowName: string,
  step: WorkflowStep,
  iterationIndex?: number,
  iterationTotal?: number
): WorkflowStepRecord {
  const id = `wf-${workflowName}-${step.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();
  
  db.prepare(`
    INSERT INTO workflow_steps (
      id, workflow_id, workflow_name, step_id, agent, status, 
      iteration_index, iteration_total, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    id, workflowId, workflowName, step.id, step.agent,
    iterationIndex ?? null, iterationTotal ?? null, createdAt
  );
  
  return {
    id,
    workflowId,
    workflowName,
    stepId: step.id,
    agent: step.agent,
    status: 'pending',
    iterationIndex,
    iterationTotal,
    createdAt
  };
}

function updateWorkflowStep(
  db: Database,
  id: string,
  fields: Partial<Pick<WorkflowStepRecord, 'status' | 'input' | 'output' | 'error' | 'startedAt' | 'finishedAt'>>
): void {
  if (fields.status !== undefined) {
    db.prepare("UPDATE workflow_steps SET status = ? WHERE id = ?").run(fields.status, id);
  }
  if (fields.input !== undefined) {
    db.prepare("UPDATE workflow_steps SET input = ? WHERE id = ?").run(fields.input, id);
  }
  if (fields.output !== undefined) {
    db.prepare("UPDATE workflow_steps SET output = ? WHERE id = ?").run(fields.output, id);
  }
  if (fields.error !== undefined) {
    db.prepare("UPDATE workflow_steps SET error = ? WHERE id = ?").run(fields.error, id);
  }
  if (fields.startedAt !== undefined) {
    db.prepare("UPDATE workflow_steps SET started_at = ? WHERE id = ?").run(fields.startedAt, id);
  }
  if (fields.finishedAt !== undefined) {
    db.prepare("UPDATE workflow_steps SET finished_at = ? WHERE id = ?").run(fields.finishedAt, id);
  }
}

// ── Spawn a pi subagent process ────────────────────────────────────────────────

function getPiCommand(): { cmd: string; args: string[] } {
  // Always use the pi binary directly — never re-spawn process.argv[1] (which
  // would restart the full service stack and corrupt the subprocess output).
  const piFromEnv = process.env.PI_BIN;
  if (piFromEnv) return { cmd: piFromEnv, args: [] };

  // Common install locations
  const candidates = [
    "/home/linuxbrew/.linuxbrew/bin/pi",
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];
  for (const p of candidates) {
    try { require("fs").accessSync(p); return { cmd: p, args: [] }; } catch (err) {
      logger.debug("Pi binary not found at candidate path", { path: p, error: err });
    }
  }

  // Last resort: check if pi is on PATH
  try {
    const result = spawnSync("which", ["pi"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      return { cmd: "pi", args: [] };
    }
  } catch (err) {
    // which command failed or not available
  }

  // Pi binary not found anywhere - throw clear error
  throw new Error(
    "pi binary not found. Install from github.com/badlogic/pi-mono or set PI_BIN environment variable"
  );
}

async function spawnAgent(
  agent: AgentDefinition,
  input: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal
): Promise<{ output: string; exitCode: number; stderr: string }> {
  // Write system prompt to temp file
  const tmpFile = path.join(cwd, `.tmp-agent-${Date.now()}.md`);
  await fs.writeFile(tmpFile, agent.systemPrompt, "utf-8");

  const taskJson = JSON.stringify(input, null, 2);
  const prompt = `Input:\n\`\`\`json\n${taskJson}\n\`\`\`\n\nPlease complete this task and return structured output.`;

  const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];

  // Model override
  if (agent.model?.id) {
    const modelStr = agent.model.provider
      ? `${agent.model.provider}/${agent.model.id}`
      : agent.model.id;
    piArgs.push("--model", modelStr);
  }

  // Tool restrictions
  if (agent.tools && agent.tools.length > 0) {
    piArgs.push("--tools", agent.tools.join(","));
  }

  piArgs.push("--append-system-prompt", tmpFile);
  piArgs.push(prompt);

  return new Promise((resolve, reject) => {
    const { cmd, args } = getPiCommand();
    const proc = spawn(cmd, [...args, ...piArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", async (code) => {
      // Clean up temp file
      fs.unlink(tmpFile).catch(() => { });

      // Extract final assistant text from JSON mode output
      let finalText = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const textParts = (event.message.content ?? [])
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text);
            if (textParts.length) finalText = textParts.join("");
          }
        } catch (err) {
          logger.debug("Failed to parse JSON event from pi output", { preview: line.slice(0, 50), error: err });
        }
      }

      resolve({ output: finalText || stdout, exitCode: code ?? 0, stderr });
    });

    proc.on("error", (err) => {
      fs.unlink(tmpFile).catch(() => { });
      reject(err);
    });

    // Timeout
    const timeoutMs = (agent.timeout_minutes ?? 15) * 60 * 1000;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
    }, timeoutMs);

    // Abort signal
    if (signal) {
      const onAbort = () => {
        killed = true;
        proc.kill("SIGTERM");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", () => {
      clearTimeout(timer);
    });
  });
}

// ── Template resolution helper ────────────────────────────────────────────────

function resolveTemplate(
  template: string,
  workflowInput: Record<string, unknown>,
  stepOutputs: Record<string, unknown>,
  currentItem: unknown
): string {
  let resolved = template;

  // {{workflow.input.key}}
  resolved = resolved.replace(/\{\{workflow\.input\.(\w+)\}\}/g, (_: string, k: string) =>
    String(workflowInput[k] ?? ""));

  // {{steps.id.output.field}} — for iterate_over, returns raw parsed value
  resolved = resolved.replace(/\{\{steps\.(\w+)\.output\.(\w+)\}\}/g, (_: string, stepId: string, field: string) => {
    const raw = stepOutputs[stepId];
    if (raw === undefined || raw === null) return "";
    
    // If it's already an object, access the field directly
    if (typeof raw === 'object' && field in (raw as Record<string, unknown>)) {
      const val = (raw as Record<string, unknown>)[field];
      return Array.isArray(val) || (typeof val === 'object' && val !== null)
        ? JSON.stringify(val)
        : String(val ?? "");
    }
    
    // Otherwise try to parse as JSON
    if (typeof raw === 'string') {
      // Strip markdown fences
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw;
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const val = parsed[field];
        return Array.isArray(val) || (typeof val === 'object' && val !== null)
          ? JSON.stringify(val)
          : String(val ?? "");
      } catch (err) {
        logger.debug("Failed to parse JSON output", { preview: jsonStr.slice(0, 100), error: err });
        return String(raw);
      }
    }
    
    return String(raw);
  });

  // {{steps.id.output}}
  resolved = resolved.replace(/\{\{steps\.(\w+)\.output\}\}/g, (_: string, stepId: string) => {
    const raw = stepOutputs[stepId];
    if (raw === undefined || raw === null) return "";
    if (typeof raw === 'string') return raw;
    return JSON.stringify(raw);
  });

  // {{item.field}} and {{item}} (only if currentItem is provided)
  if (currentItem !== null) {
    // {{item.field}}
    resolved = resolved.replace(/\{\{item\.(\w+)\}\}/g, (_: string, field: string) => {
      if (typeof currentItem === 'object' && currentItem !== null && field in currentItem) {
        return String((currentItem as Record<string, unknown>)[field] ?? "");
      }
      return "";
    });

    // {{item}}
    resolved = resolved.replace(/\{\{item\}\}/g, () => {
      if (typeof currentItem === 'string') return currentItem;
      return JSON.stringify(currentItem);
    });
  }

  return resolved;
}

// ── Extension factory ─────────────────────────────────────────────────────────

export function subagentManagerExtensionFactory(opts: SubagentManagerOptions) {
  return async (pi: ExtensionAPI) => {
    const { projectRoot, agentsDir, memoryRoot, dataRoot, getDomain } = opts;
    const workflowsDir = opts.workflowsDir ?? path.join(projectRoot, "workflows");

    // Open SQLite run tracking DB
    const db = openRunsDb(dataRoot);

    // Resolve workingDir for this domain from domains manifest
    // Default: data/scratch/ (isolated from project source tree)
    const scratchDir = path.join(dataRoot, "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    let domainWorkingDir: string = scratchDir;
    try {
      const manifest = await readDomainsManifest(memoryRoot);
      const domainEntry = manifest.domains.find(d => d.id === getDomain());
      if (domainEntry?.workingDir) domainWorkingDir = domainEntry.workingDir;
    } catch (err) {
      logger.debug("Failed to load domains manifest for workingDir", { error: err });
      // fallback to scratchDir
    }

    // Validate domainWorkingDir exists and is accessible
    if (domainWorkingDir !== scratchDir) {
      try {
        await fs.access(domainWorkingDir, fs.constants.R_OK | fs.constants.W_OK);
      } catch (err) {
        logger.warn("Configured workingDir not accessible, falling back to scratchDir", { 
          workingDir: domainWorkingDir, 
          scratchDir,
          error: err 
        });
        domainWorkingDir = scratchDir;
      }
    }

    // Load agent definitions eagerly at extension init — factory supports async
    const agentRegistry = await loadAgents(agentsDir);
    if (agentRegistry.length === 0) {
      logger.warn("No agent definitions found", { agentsDir });
    } else {
      logger.info("Loaded agents", { count: agentRegistry.length, agents: agentRegistry.map(a => a.name).join(", ") });
    }

    // ── spawn_subagent tool ──────────────────────────────────────────────────

    pi.registerTool({
      name: "spawn_subagent",
      label: "Spawn Subagent",
      description: [
        "Spawn a specialist subagent to handle a complex task asynchronously.",
        "The subagent runs in isolation with its own context and tools.",
        "Returns a run ID immediately; completion is notified via a follow-up message.",
        "Available agents: researcher, architect, developer, qa (and any in agents/)",
      ].join(" "),
      promptSnippet: "Spawn a named specialist subagent for complex tasks (researcher, architect, developer, qa)",
      parameters: Type.Object({
        agent: Type.String({ description: "Agent name from agents/*.md (e.g. 'researcher', 'developer')" }),
        input: Type.Record(Type.String(), Type.Unknown(), {
          description: "Input object matching the agent's input_schema",
        }),
        notify_on_complete: Type.Optional(Type.Boolean({
          description: "Send a follow-up message when done. Default: true",
          default: true,
        })),
      }),

      async execute(_id, params, signal, _onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
        const agentDef = agentRegistry.find(a => a.name === params.agent);
        if (!agentDef) {
          const available = agentRegistry.map(a => a.name).join(", ") || "(none loaded)";
          return {
            content: [{ type: "text", text: `❌ Unknown agent '${params.agent}'. Available: ${available}` }],
            details: { agent: params.agent, found: false },
          };
        }

        const run = createRun(db, params.agent, params.input as Record<string, unknown>, agentDef.model?.provider, agentDef.model?.id);
        const notify = params.notify_on_complete !== false;

        // Fire and forget — run async
        (async () => {
          let attempt = 0;
          const maxRetries = agentDef.on_failure?.retry ?? 0;
          let lastStderr = "";

          while (attempt <= maxRetries) {
            try {
              const result = await spawnAgent(agentDef, params.input as Record<string, unknown>, domainWorkingDir, signal);
              lastStderr = result.stderr || "";

              if (result.exitCode === 0) {
                const finishedAt = Date.now();
                updateRun(db, run.id, { status: "done", output: result.output, stderr: result.stderr || undefined, finishedAt });
                if (notify) {
                  const elapsed = ((finishedAt - run.startedAt) / 1000).toFixed(0);
                  pi.sendUserMessage(
                    `✅ Subagent **${params.agent}** completed (run: ${run.id}, ${elapsed}s)\n\n${result.output}`,
                    { deliverAs: "followUp" }
                  );
                }

                pi.events.emit("subagent:complete", { id: run.id, agent: params.agent, output: result.output });
                return;
              }

              throw new Error(`Exit code ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
            } catch (err) {
              attempt++;
              updateRun(db, run.id, { retries: attempt });

              if (attempt > maxRetries) {
                const finishedAt = Date.now();
                const error = String(err);
                updateRun(db, run.id, { status: "failed", error, stderr: lastStderr || undefined, finishedAt });
                const action = agentDef.on_failure?.then ?? "report_to_majordomo";
                if (action === "report_to_majordomo") {
                  pi.sendUserMessage(
                    `❌ Subagent **${params.agent}** failed after ${attempt} attempt(s) (run: ${run.id})\n\nError: ${error}`,
                    { deliverAs: "followUp" }
                  );
                }

                pi.events.emit("subagent:failed", { id: run.id, agent: params.agent, error });
              } else {
                logger.info("Subagent run failed, retrying", { runId: run.id, attempt, maxRetries });
                await new Promise(r => setTimeout(r, 2000 * attempt)); // backoff
              }
            }
          }
        })();

        return {
          content: [{ type: "text", text: `⚡ Subagent **${params.agent}** started (run: ${run.id}). I'll notify you when it completes.` }],
          details: { runId: run.id, agent: params.agent, status: "running" },
        };
      },
    });

    // ── list_agents tool ─────────────────────────────────────────────────────

    pi.registerTool({
      name: "list_agents",
      label: "List Agents",
      description: "List available subagent definitions loaded from agents/*.md",
      promptSnippet: "List available specialist subagents",
      parameters: Type.Object({}),

      async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
        if (agentRegistry.length === 0) {
          return {
            content: [{ type: "text", text: "No agent definitions found in agents/. Add *.md files with YAML frontmatter." }],
            details: { agents: [] },
          };
        }

        const text = agentRegistry.map(a => {
          const model = a.model?.id ? `model: ${a.model.provider ?? ""}/${a.model.id}` : "";
          const tools = a.tools ? `tools: ${a.tools.join(", ")}` : "";
          const timeout = a.timeout_minutes ? `timeout: ${a.timeout_minutes}m` : "";
          const meta = [model, tools, timeout].filter(Boolean).join(" | ");
          return `**${a.name}** — ${a.label}${meta ? `\n  ${meta}` : ""}`;
        }).join("\n\n");

        return {
          content: [{ type: "text", text }],
          details: { agents: agentRegistry.map(a => ({ name: a.name, label: a.label })) },
        };
      },
    });

    // ── subagent_status tool ─────────────────────────────────────────────────

    pi.registerTool({
      name: "subagent_status",
      label: "Subagent Status",
      description: "Check the status of a subagent run by its run ID, or list all recent runs.",
      promptSnippet: "Check subagent run status or list recent runs",
      parameters: Type.Object({
        run_id: Type.Optional(Type.String({ description: "Run ID from spawn_subagent output. Omit to list recent runs." })),
      }),

      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        if (params.run_id) {
          const run = getRun(db, params.run_id);
          if (!run) {
            return {
              content: [{ type: "text", text: `No run found with ID '${params.run_id}'` }],
              details: { found: false },
            };
          }

          const elapsed = run.finishedAt
            ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(0)}s`
            : `${((Date.now() - run.startedAt) / 1000).toFixed(0)}s (running)`;

          const text = [
            `**Run:** ${run.id}`,
            `**Agent:** ${run.agent}`,
            `**Status:** ${run.status}`,
            run.provider ? `**Provider:** ${run.provider}` : "",
            run.model ? `**Model:** ${run.model}` : "",
            `**Elapsed:** ${elapsed}`,
            run.retries > 0 ? `**Retries:** ${run.retries}` : "",
            run.error ? `**Error:** ${run.error}` : "",
            run.stderr ? `**Stderr:** ${run.stderr.slice(0, 300)}` : "",
            run.output ? `**Output preview:** ${run.output.slice(0, 200)}…` : "",
          ].filter(Boolean).join("\n");

          return { content: [{ type: "text", text }], details: { run } };
        }

        // List recent runs (last 10)
        const recent = getRecentRuns(db, 10);

        if (recent.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent runs yet." }],
            details: { runs: [] },
          };
        }

        const text = recent.map(r => {
          const age = Math.round((Date.now() - r.startedAt) / 1000);
          const icon = r.status === "done" ? "✅" : r.status === "failed" ? "❌" : "⏳";
          return `${icon} ${r.id} — ${r.agent} (${r.status}, ${age}s ago)`;
        }).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { runs: recent },
        };
      },
    });

    // ── run_workflow tool ────────────────────────────────────────────────────

    pi.registerTool({
      name: "run_workflow",
      label: "Run Workflow",
      description: [
        "Run a named workflow defined in workflows/*.yaml.",
        "Workflows chain multiple subagents: each step's output becomes the next step's input.",
        "Returns immediately; each step completion sends a notification.",
      ].join(" "),
      promptSnippet: "Run a named multi-step subagent workflow",
      parameters: Type.Object({
        workflow: Type.String({ description: "Workflow name (filename without .yaml)" }),
        input: Type.Record(Type.String(), Type.Unknown(), {
          description: "Initial workflow input matching the first step's requirements",
        }),
      }),

      async execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
        const workflowFile = path.join(workflowsDir, `${params.workflow}.yaml`);

        let workflowDef: { name: string; steps: WorkflowStep[] };
        try {
          const content = await fs.readFile(workflowFile, "utf-8");
          workflowDef = yaml.load(content) as typeof workflowDef;
        } catch (err) {
          logger.debug("Workflow file not found", { workflow: params.workflow, error: err });
          return {
            content: [{ type: "text", text: `❌ Workflow '${params.workflow}' not found in workflows/` }],
            details: { workflow: params.workflow, found: false },
          };
        }

        const workflowId = `wf-${params.workflow}-${Date.now()}`;

        // Emit workflow start event
        pi.events.emit("workflow:started", { 
          workflowId, 
          workflowName: params.workflow,
          totalSteps: workflowDef.steps.length,
          timestamp: Date.now()
        });

        // Execute workflow asynchronously
        (async () => {
          const stepOutputs: Record<string, unknown> = {};
          const workflowInput = params.input as Record<string, unknown>;

          for (const step of workflowDef.steps) {
            if (signal?.aborted) break;

            const agentDef = agentRegistry.find(a => a.name === step.agent);
            if (!agentDef) {
              pi.sendUserMessage(
                `❌ Workflow **${params.workflow}** step **${step.id}**: unknown agent '${step.agent}'`,
                { deliverAs: "followUp" }
              );
              return;
            }

            // Check if this step has iterate_over
            let iterationArray: unknown[] = [];
            if (step.iterate_over) {
              // Resolve the iterate_over expression to get an array
              const iterateExpr = step.iterate_over;
              const resolved = resolveTemplate(iterateExpr, workflowInput, stepOutputs, null);
              
              // Try to parse as JSON array if it's a string
              try {
                let toParse = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
                // Strip markdown code fences if present (e.g. ```json ... ```)
                const fenceMatch = toParse.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (fenceMatch) toParse = fenceMatch[1].trim();

                // Attempt 1: standard JSON parse
                let parsed: unknown = null;
                try {
                  parsed = JSON.parse(toParse);
                } catch {
                  // Attempt 2: truncated JSON — extract individual objects with regex
                  // Handles case where output is cut off mid-JSON
                  const objMatches = toParse.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
                  const extracted: unknown[] = [];
                  for (const m of objMatches) {
                    try { extracted.push(JSON.parse(m[0])); } catch { /* skip malformed */ }
                  }
                  if (extracted.length > 0) {
                    parsed = extracted;
                    console.warn(`[workflow] iterate_over: used regex fallback, extracted ${extracted.length} items from truncated JSON`);
                  } else {
                    throw new Error(`Could not parse JSON (tried standard + regex extraction): ${String(toParse).slice(0, 300)}`);
                  }
                }

                // Handle both direct arrays and objects with an array field
                if (Array.isArray(parsed)) {
                  iterationArray = parsed;
                } else if (parsed && typeof parsed === 'object') {
                  // Find first array field in the parsed object
                  const arrayField = Object.values(parsed as Record<string, unknown>).find(v => Array.isArray(v));
                  if (arrayField) {
                    iterationArray = arrayField as unknown[];
                  } else {
                    pi.sendUserMessage(
                      `❌ Workflow **${params.workflow}** step **${step.id}**: iterate_over resolved to object with no array field. Got: ${toParse.slice(0, 200)}`,
                      { deliverAs: "followUp" }
                    );
                    return;
                  }
                } else {
                  pi.sendUserMessage(
                    `❌ Workflow **${params.workflow}** step **${step.id}**: iterate_over did not resolve to an array. Got: ${toParse.slice(0, 200)}`,
                    { deliverAs: "followUp" }
                  );
                  return;
                }
              } catch (e) {
                pi.sendUserMessage(
                  `❌ Workflow **${params.workflow}** step **${step.id}**: failed to parse iterate_over result. Error: ${e}. Value: ${String(resolved).slice(0, 200)}`,
                  { deliverAs: "followUp" }
                );
                return;
              }
            }

            // If iterate_over is set, run the agent for each item
            if (step.iterate_over && iterationArray.length > 0) {
              pi.sendUserMessage(
                `⚡ Workflow **${params.workflow}** — step **${step.id}** (${step.agent}) iterating over ${iterationArray.length} items…`,
                { deliverAs: "followUp" }
              );

              const outputs: unknown[] = [];
              let successCount = 0;
              let skipCount = 0;

              for (let i = 0; i < iterationArray.length; i++) {
                if (signal?.aborted) break;

                const item = iterationArray[i];
                const itemNumber = i + 1;

                // Create step record
                const stepRecord = createWorkflowStep(
                  db, workflowId, params.workflow, step, i, iterationArray.length
                );
                
                // Emit step start
                pi.events.emit("workflow:step_start", {
                  workflowId,
                  stepId: step.id,
                  agent: step.agent,
                  recordId: stepRecord.id,
                  iterationIndex: i,
                  iterationTotal: iterationArray.length,
                  timestamp: Date.now()
                });

                // Resolve input with {{item}} and {{item.field}} support
                const resolvedInput: Record<string, unknown> = {};
                for (const [key, tmpl] of Object.entries(step.input)) {
                  resolvedInput[key] = resolveTemplate(tmpl, workflowInput, stepOutputs, item);
                }

                updateWorkflowStep(db, stepRecord.id, { 
                  status: 'running', 
                  input: JSON.stringify(resolvedInput),
                  startedAt: Date.now() 
                });

                pi.sendUserMessage(
                  `  ⚡ Item ${itemNumber}/${iterationArray.length}: ${typeof item === 'object' && item !== null && 'title' in item ? (item as { title: string }).title : 'running'}…`,
                  { deliverAs: "followUp" }
                );

                try {
                  const result = await spawnAgent(agentDef, resolvedInput, domainWorkingDir, signal);

                  if (result.exitCode === 0) {
                    outputs.push(result.output);
                    successCount++;
                    updateWorkflowStep(db, stepRecord.id, { 
                      status: 'done', 
                      output: result.output, 
                      finishedAt: Date.now() 
                    });
                    
                    pi.events.emit("workflow:step_complete", {
                      workflowId,
                      stepId: step.id,
                      agent: step.agent,
                      recordId: stepRecord.id,
                      iterationIndex: i,
                      output: result.output,
                      timestamp: Date.now()
                    });
                    
                    pi.sendUserMessage(
                      `  ✅ Item ${itemNumber}/${iterationArray.length} completed`,
                      { deliverAs: "followUp" }
                    );
                  } else {
                    // If retry is 0, skip this item and continue
                    const retryCount = agentDef.on_failure?.retry ?? 0;
                    if (retryCount === 0) {
                      skipCount++;
                      updateWorkflowStep(db, stepRecord.id, { 
                        status: 'skipped', 
                        error: result.stderr,
                        finishedAt: Date.now() 
                      });
                      
                      pi.events.emit("workflow:step_failed", {
                        workflowId,
                        stepId: step.id,
                        agent: step.agent,
                        recordId: stepRecord.id,
                        error: result.stderr,
                        skipped: true,
                        timestamp: Date.now()
                      });
                      
                      pi.sendUserMessage(
                        `  ⚠️  Item ${itemNumber}/${iterationArray.length} failed, skipping: ${result.stderr.slice(0, 100)}`,
                        { deliverAs: "followUp" }
                      );
                    } else {
                      updateWorkflowStep(db, stepRecord.id, { 
                        status: 'failed', 
                        error: result.stderr,
                        finishedAt: Date.now() 
                      });
                      
                      pi.events.emit("workflow:step_failed", {
                        workflowId,
                        stepId: step.id,
                        agent: step.agent,
                        recordId: stepRecord.id,
                        error: result.stderr,
                        timestamp: Date.now()
                      });
                      
                      pi.events.emit("workflow:complete", { 
                        workflowId, 
                        workflowName: params.workflow,
                        success: false,
                        timestamp: Date.now()
                      });
                      
                      // Abort the whole workflow if retry is configured
                      pi.sendUserMessage(
                        `❌ Workflow **${params.workflow}** stopped at step **${step.id}** item ${itemNumber}: ${result.stderr.slice(0, 200)}`,
                        { deliverAs: "followUp" }
                      );
                      return;
                    }
                  }
                } catch (err) {
                  const retryCount = agentDef.on_failure?.retry ?? 0;
                  if (retryCount === 0) {
                    skipCount++;
                    updateWorkflowStep(db, stepRecord.id, { 
                      status: 'skipped', 
                      error: String(err),
                      finishedAt: Date.now() 
                    });
                    
                    pi.sendUserMessage(
                      `  ⚠️  Item ${itemNumber}/${iterationArray.length} failed, skipping: ${String(err).slice(0, 100)}`,
                      { deliverAs: "followUp" }
                    );
                  } else {
                    updateWorkflowStep(db, stepRecord.id, { 
                      status: 'failed', 
                      error: String(err),
                      finishedAt: Date.now() 
                    });
                    
                    pi.events.emit("workflow:complete", { 
                      workflowId, 
                      workflowName: params.workflow,
                      success: false,
                      timestamp: Date.now()
                    });
                    
                    pi.sendUserMessage(
                      `❌ Workflow **${params.workflow}** stopped at step **${step.id}** item ${itemNumber}: ${String(err).slice(0, 200)}`,
                      { deliverAs: "followUp" }
                    );
                    return;
                  }
                }
              }

              stepOutputs[step.id] = outputs;
              pi.sendUserMessage(
                `✅ Step **${step.id}** complete: ${successCount} succeeded${skipCount > 0 ? `, ${skipCount} skipped` : ''}`,
                { deliverAs: "followUp" }
              );
            } else {
              // Normal single execution (no iteration)
              // Create step record
              const stepRecord = createWorkflowStep(
                db, workflowId, params.workflow, step
              );
              
              // Emit step start
              pi.events.emit("workflow:step_start", {
                workflowId,
                stepId: step.id,
                agent: step.agent,
                recordId: stepRecord.id,
                timestamp: Date.now()
              });
              
              // Resolve template expressions:
              //   {{workflow.input.key}}          — workflow input field
              //   {{steps.id.output}}             — full step output text
              //   {{steps.id.output.field}}        — field from JSON-parsed step output
              const resolvedInput: Record<string, unknown> = {};
              for (const [key, tmpl] of Object.entries(step.input)) {
                resolvedInput[key] = resolveTemplate(tmpl, workflowInput, stepOutputs, null);
              }

              updateWorkflowStep(db, stepRecord.id, { 
                status: 'running', 
                input: JSON.stringify(resolvedInput),
                startedAt: Date.now() 
              });

              pi.sendUserMessage(
                `⚡ Workflow **${params.workflow}** — step **${step.id}** (${step.agent}) starting…`,
                { deliverAs: "followUp" }
              );

              try {
                const result = await spawnAgent(agentDef, resolvedInput, domainWorkingDir, signal);

                if (result.exitCode !== 0) {
                  updateWorkflowStep(db, stepRecord.id, { 
                    status: 'failed', 
                    error: result.stderr,
                    finishedAt: Date.now() 
                  });
                  
                  pi.events.emit("workflow:step_failed", {
                    workflowId,
                    stepId: step.id,
                    agent: step.agent,
                    recordId: stepRecord.id,
                    error: result.stderr,
                    timestamp: Date.now()
                  });
                  
                  pi.events.emit("workflow:complete", { 
                    workflowId, 
                    workflowName: params.workflow,
                    success: false,
                    timestamp: Date.now()
                  });
                  
                  pi.sendUserMessage(
                    `❌ Workflow **${params.workflow}** stopped at step **${step.id}**: ${result.stderr.slice(0, 200)}`,
                    { deliverAs: "followUp" }
                  );
                  return;
                }

                stepOutputs[step.id] = result.output;
                updateWorkflowStep(db, stepRecord.id, { 
                  status: 'done', 
                  output: result.output, 
                  finishedAt: Date.now() 
                });
                
                pi.events.emit("workflow:step_complete", {
                  workflowId,
                  stepId: step.id,
                  agent: step.agent,
                  recordId: stepRecord.id,
                  output: result.output,
                  timestamp: Date.now()
                });
              } catch (err) {
                updateWorkflowStep(db, stepRecord.id, { 
                  status: 'failed', 
                  error: String(err),
                  finishedAt: Date.now() 
                });
                
                pi.events.emit("workflow:step_failed", {
                  workflowId,
                  stepId: step.id,
                  agent: step.agent,
                  recordId: stepRecord.id,
                  error: String(err),
                  timestamp: Date.now()
                });
                
                pi.events.emit("workflow:complete", { 
                  workflowId, 
                  workflowName: params.workflow,
                  success: false,
                  timestamp: Date.now()
                });
                
                pi.sendUserMessage(
                  `❌ Workflow **${params.workflow}** stopped at step **${step.id}**: ${String(err).slice(0, 200)}`,
                  { deliverAs: "followUp" }
                );
                return;
              }
            }
          }

          // Workflow completed successfully
          pi.events.emit("workflow:complete", { 
            workflowId, 
            workflowName: params.workflow,
            success: true,
            timestamp: Date.now()
          });
          
          const lastStep = workflowDef.steps[workflowDef.steps.length - 1];
          const lastOutput = stepOutputs[lastStep.id];
          const outputText = Array.isArray(lastOutput) 
            ? `${lastOutput.length} items completed` 
            : String(lastOutput ?? "(no output)");

          pi.sendUserMessage(
            `✅ Workflow **${params.workflow}** complete!\n\nFinal output:\n${outputText}`,
            { deliverAs: "followUp" }
          );

          // After workflow completes, sync mentat if structural changes were made
          // (only for improve-codebase workflow with certain categories)
          if (params.workflow === "improve-codebase") {
            const hasStructuralChanges = Object.values(stepOutputs).some(output => {
              const text = String(output);
              return text.includes("consolidat") || 
                     text.includes("restructur") || 
                     text.includes("remov") ||
                     text.includes("architect") ||
                     text.includes("dead-code");
            });

            if (hasStructuralChanges) {
              try {
                const { mentatSync, isMentatAvailable, hasAgenticHarness } = await import("../../lib/mentat.ts");
                if (await isMentatAvailable() && await hasAgenticHarness(domainWorkingDir)) {
                  logger.info("Structural changes detected, syncing mentat", { workflowId });
                  await mentatSync(domainWorkingDir);
                  pi.sendUserMessage(
                    "🔄 Structural changes detected — refreshed .agentic/ harness (skills + MAP.md)",
                    { deliverAs: "followUp" }
                  );
                }
              } catch (err) {
                logger.warn("Failed to sync mentat after workflow", { workflowId, error: err });
              }
            }
          }
        })();

        return {
          content: [{ type: "text", text: `⚡ Workflow **${params.workflow}** started (id: ${workflowId}). I'll update you as each step completes.` }],
          details: { workflowId, workflow: params.workflow },
        };
      },
    });
  };
}

// ── Default export ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const projectRoot = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
  const getDomain = () => process.env.MAJORDOMO_DOMAIN ?? "general";
  subagentManagerExtensionFactory({
    projectRoot,
    agentsDir: path.join(projectRoot, "agents"),
    dataRoot: path.join(projectRoot, "data"),
    memoryRoot: process.env.MAJORDOMO_MEMORY_ROOT ?? path.join(projectRoot, "memory"),
    getDomain,
  })(pi);
}
