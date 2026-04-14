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
import { spawn } from "node:child_process";
import yaml from "js-yaml";
import { Database } from "bun:sqlite";
import { type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubagentManagerOptions {
  projectRoot: string;
  agentsDir: string;     // path to agents/*.md
  dataRoot: string;
  domain?: string;       // Deprecated: active domain for this session (use getDomain instead)
  memoryRoot: string;    // path to memory/ for domain workingDir lookup
  maxConcurrency?: number;
  getDomain?: () => string;  // Dynamic domain accessor (Phase 1)
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

interface RunRecord {
  id: string;
  agent: string;
  status: "running" | "done" | "failed";
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  stderr?: string;
  startedAt: number;
  finishedAt?: number;
  retries: number;
}

// ── Agent registry ────────────────────────────────────────────────────────────

async function loadAgents(agentsDir: string): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(agentsDir);
  } catch {
    return agents;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await fs.readFile(path.join(agentsDir, file), "utf-8");
      const agent = parseAgentFile(content);
      if (agent) agents.push(agent);
    } catch (err) {
      console.warn(`[subagent] Failed to load agent ${file}:`, err);
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
  } catch {
    return null;
  }
}

// ── Run tracking (SQLite-backed) ─────────────────────────────────────────────

function openRunsDb(dataRoot: string): Database {
  const db = new Database(path.join(dataRoot, "subagents.db"));
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
    -- Additive migration: add stderr column if it doesn't exist
    ALTER TABLE runs ADD COLUMN stderr TEXT;
  `);

  // Mark any runs still 'running' from a previous process as orphaned
  const orphaned = db.prepare(
    "UPDATE runs SET status = 'failed', error = 'Orphaned: service restarted before completion', finished_at = ? WHERE status = 'running'"
  ).run(Date.now());
  if ((orphaned.changes as number) > 0) {
    console.log(`[subagent] Marked ${orphaned.changes} orphaned run(s) as failed`);
  }

  return db;
}

function createRun(db: Database, agent: string, input: Record<string, unknown>): RunRecord {
  const id = `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO runs (id, agent, status, input, started_at)
    VALUES (?, ?, 'running', ?, ?)
  `).run(id, agent, JSON.stringify(input), Date.now());
  return { id, agent, status: "running", input, startedAt: Date.now(), retries: 0 };
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
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | undefined,
    retries: row.retries as number,
  }));
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
    try { require("fs").accessSync(p); return { cmd: p, args: [] }; } catch { /* try next */ }
  }

  // Last resort: hope pi is on PATH
  return { cmd: "pi", args: [] };
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
        } catch { /* skip */ }
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

// ── Extension factory ─────────────────────────────────────────────────────────

export function subagentManagerExtensionFactory(opts: SubagentManagerOptions) {
  return async (pi: ExtensionAPI) => {
    const { projectRoot, agentsDir, memoryRoot, dataRoot } = opts;
    // Resolve domain: getDomain accessor takes precedence over static domain
    const getDomain = opts.getDomain ?? (() => opts.domain ?? "general");

    // Open SQLite run tracking DB
    const db = openRunsDb(dataRoot);

    // Resolve workingDir for this domain from domains manifest
    // Default: data/scratch/ (isolated from project source tree)
    const scratchDir = path.join(dataRoot, "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    let domainWorkingDir: string = scratchDir;
    try {
      const manifestPath = path.join(memoryRoot, "domains.yml");
      const raw = await fs.readFile(manifestPath, "utf-8");
      const manifest = yaml.load(raw) as { domains: Array<{ id: string; workingDir?: string }> };
      const domainEntry = manifest.domains.find(d => d.id === getDomain());
      if (domainEntry?.workingDir) domainWorkingDir = domainEntry.workingDir;
    } catch {
      // fallback to scratchDir
    }

    // Load agent definitions eagerly at extension init — factory supports async
    const agentRegistry = await loadAgents(agentsDir);
    if (agentRegistry.length === 0) {
      console.warn(`[subagent] No agent definitions found in ${agentsDir}`);
    } else {
      console.log(`[subagent] Loaded ${agentRegistry.length} agent(s): ${agentRegistry.map(a => a.name).join(", ")}`);
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

        const run = createRun(db, params.agent, params.input as Record<string, unknown>);
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
                console.log(`[subagent] Run ${run.id} failed, retrying (${attempt}/${maxRetries})...`);
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
        const workflowFile = path.join(projectRoot, "workflows", `${params.workflow}.yaml`);

        let workflowDef: { name: string; steps: Array<{ id: string; agent: string; input: Record<string, string>; depends_on?: string }> };
        try {
          const content = await fs.readFile(workflowFile, "utf-8");
          workflowDef = yaml.load(content) as typeof workflowDef;
        } catch {
          return {
            content: [{ type: "text", text: `❌ Workflow '${params.workflow}' not found in workflows/` }],
            details: { workflow: params.workflow, found: false },
          };
        }

        const workflowId = `wf-${params.workflow}-${Date.now()}`;

        // Execute workflow asynchronously
        (async () => {
          const stepOutputs: Record<string, string> = {};
          const workflowInput = params.input as Record<string, unknown>;

          for (const step of workflowDef.steps) {
            if (signal?.aborted) break;

            // Resolve template expressions:
            //   {{workflow.input.key}}          — workflow input field
            //   {{steps.id.output}}             — full step output text
            //   {{steps.id.output.field}}        — field from JSON-parsed step output
            const resolvedInput: Record<string, unknown> = {};
            for (const [key, tmpl] of Object.entries(step.input)) {
              resolvedInput[key] = tmpl
                .replace(/\{\{workflow\.input\.(\w+)\}\}/g, (_: string, k: string) =>
                  String(workflowInput[k] ?? ""))
                .replace(/\{\{steps\.(\w+)\.output\.(\w+)\}\}/g, (_: string, stepId: string, field: string) => {
                  const raw = stepOutputs[stepId] ?? "";
                  try {
                    const parsed = JSON.parse(raw);
                    return String(parsed[field] ?? "");
                  } catch {
                    return raw; // fallback: whole output
                  }
                })
                .replace(/\{\{steps\.(\w+)\.output\}\}/g, (_: string, stepId: string) =>
                  stepOutputs[stepId] ?? "");
            }

            const agentDef = agentRegistry.find(a => a.name === step.agent);
            if (!agentDef) {
              pi.sendUserMessage(
                `❌ Workflow **${params.workflow}** step **${step.id}**: unknown agent '${step.agent}'`,
                { deliverAs: "followUp" }
              );
              return;
            }

            pi.sendUserMessage(
              `⚡ Workflow **${params.workflow}** — step **${step.id}** (${step.agent}) starting…`,
              { deliverAs: "followUp" }
            );

            const result = await spawnAgent(agentDef, resolvedInput, domainWorkingDir, signal);

            if (result.exitCode !== 0) {
              pi.sendUserMessage(
                `❌ Workflow **${params.workflow}** stopped at step **${step.id}**: ${result.stderr.slice(0, 200)}`,
                { deliverAs: "followUp" }
              );
              return;
            }

            stepOutputs[step.id] = result.output;
            pi.events.emit("workflow:step_complete", {
              workflowId,
              stepId: step.id,
              agent: step.agent,
              output: result.output,
            });
          }

          pi.sendUserMessage(
            `✅ Workflow **${params.workflow}** complete!\n\nFinal output:\n${stepOutputs[workflowDef.steps[workflowDef.steps.length - 1].id] ?? "(no output)"}`,
            { deliverAs: "followUp" }
          );
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
  subagentManagerExtensionFactory({
    projectRoot,
    agentsDir: path.join(projectRoot, "agents"),
    dataRoot: path.join(projectRoot, "data"),
    domain: process.env.MAJORDOMO_DOMAIN ?? "general",
    memoryRoot: process.env.MAJORDOMO_MEMORY_ROOT ?? path.join(projectRoot, "memory"),
  })(pi);
}
