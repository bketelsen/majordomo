/**
 * Scheduler Extension + COG Pipeline Skills
 *
 * Two concerns in one file (they share the scheduler DB):
 *
 * 1. SCHEDULER — cron + webhook triggers
 *    - Loads jobs from scheduler.db on startup
 *    - Auto-registers COG pipeline jobs on first run
 *    - Registers `register_schedule` and `list_schedules` tools
 *    - Exposes /webhooks/:id endpoint via webEvents for HTTP triggers
 *
 * 2. COG PIPELINE — pi commands that run COG maintenance skills as subagents
 *    /cog-foresight      daily strategic nudge
 *    /cog-reflect        weekly session mining and memory condensation
 *    /cog-housekeeping   weekly archival, pruning, index rebuild
 *    /cog-evolve         weekly architecture audit
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import cron from "node-cron";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger.ts";
import { formatError } from "../../../shared/lib/error-helpers.ts";
import { runMigrations, type Migration } from "../../lib/db-migrations.ts";
import { getGlobalWebEvents, getGlobalManager } from "../../lib/shared-state.ts";

const logger = createLogger({ context: { component: "scheduler" } });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  projectRoot: string;
  dataRoot: string;
  agentsDir: string;
  workflowsDir?: string;  // for validating workflow jobs
  getDomain: () => string;  // Dynamic domain accessor
}

interface ScheduledJob {
  id: string;
  cron: string;
  action_type: "pi_command" | "agent_prompt" | "webhook" | "workflow";
  action_data: string; // JSON
  enabled: number;     // 0 or 1
  created_at: string;
  trigger_type: "cron" | "webhook";
}

// COG pipeline skill → markdown system prompt paths
const COG_SKILL_PROMPTS: Record<string, string> = {
  foresight:    "memory/cog-meta",  // looks up foresight.md task instructions
  reflect:      "memory/cog-meta",
  housekeeping: "memory/cog-meta",
  evolve:       "memory/cog-meta",
};

// Built-in pipeline schedule (auto-registered on first startup)
const COG_PIPELINE_JOBS = [
  { id: "cog-foresight-daily",    cron: "0 7 * * *",   command: "/cog-foresight"    },
  { id: "cog-reflect-weekly",     cron: "0 2 * * 0",   command: "/cog-reflect"      },
  { id: "cog-housekeeping-weekly",cron: "0 3 * * 0",   command: "/cog-housekeeping" },
  { id: "cog-evolve-weekly",      cron: "0 4 * * 0",   command: "/cog-evolve"       },
  { id: "obsidian-daily-journal", cron: "30 23 * * *", command: "/obsidian-daily"   },
];

// ── DB schema ─────────────────────────────────────────────────────────────────

// Define schema migrations
const SCHEDULER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id          TEXT PRIMARY KEY,
          cron        TEXT NOT NULL,
          action_type TEXT NOT NULL,
          action_data TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id     TEXT NOT NULL,
          ran_at     TEXT NOT NULL,
          success    INTEGER NOT NULL,
          error      TEXT
        )
      `);
    },
  },
  {
    version: 2,
    name: "add_trigger_type_column",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(jobs)").all() as {name: string}[];
      if (!cols.some(c => c.name === 'trigger_type')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'`);
      }
    },
  },
];

function openDb(dataRoot: string): Database {
  const dbPath = path.join(dataRoot, "scheduler.db");
  const db = new Database(dbPath);

  // Run migrations
  runMigrations(db, SCHEDULER_MIGRATIONS);

  return db;
}

// ── Extension factory ─────────────────────────────────────────────────────────

export function schedulerExtensionFactory(opts: SchedulerOptions) {
  return (pi: ExtensionAPI) => {
    const { projectRoot, dataRoot, workflowsDir, getDomain } = opts;
    const db = openDb(dataRoot);
    const activeTasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();

    // ── Bootstrap COG pipeline jobs ──────────────────────────────────────────

    const ensureCogJobs = () => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO jobs (id, cron, action_type, action_data, enabled, created_at)
        VALUES (?, ?, 'pi_command', ?, 1, datetime('now'))
      `);

      for (const job of COG_PIPELINE_JOBS) {
        insert.run(job.id, job.cron, JSON.stringify({ command: job.command }));
      }
    };

    // ── Load and start all enabled jobs ──────────────────────────────────────

    const startAllJobs = () => {
      const jobs = db.prepare("SELECT * FROM jobs WHERE enabled = 1").all() as ScheduledJob[];

      for (const job of jobs) {
        startJob(job);
      }

      logger.info("Started scheduled jobs", { count: activeTasks.size });
    };

    const startJob = (job: ScheduledJob) => {
      if (activeTasks.has(job.id)) return;

      // Only schedule cron tasks for jobs with trigger_type === 'cron'
      const triggerType = job.trigger_type ?? 'cron'; // Default to cron for backward compatibility
      if (triggerType === 'webhook') {
        logger.info("Webhook job registered (no cron schedule)", { jobId: job.id });
        return; // Webhook jobs don't need cron scheduling
      }

      if (!cron.validate(job.cron)) {
        logger.warn("Invalid cron expression for job", { jobId: job.id, cron: job.cron });
        return;
      }

      const task = cron.schedule(job.cron, async () => {
        logger.info("Running scheduled job", { jobId: job.id });
        try {
          await executeJob(job);
          db.prepare("INSERT INTO runs (job_id, ran_at, success) VALUES (?, datetime('now'), 1)").run(job.id);
        } catch (err) {
          logger.error("Scheduled job failed", { jobId: job.id, error: err });
          db.prepare("INSERT INTO runs (job_id, ran_at, success, error) VALUES (?, datetime('now'), 0, ?)").run(job.id, String(err));
        }
      }, { timezone: process.env.TZ ?? "America/New_York" });

      activeTasks.set(job.id, task);
    };

    const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(process.env.HOME ?? "/root", ".majordomo");
    const cogMemoryRoot = path.join(MAJORDOMO_STATE, "memory");
    const cogCommandsDir = path.join(projectRoot, ".claude", "commands");

    const executeJob = async (job: ScheduledJob, webhookPayload?: unknown) => {
      const data = JSON.parse(job.action_data);

      // Prepare webhook context message if triggered by webhook
      const webhookContext = webhookPayload 
        ? `\n\n**Webhook payload:**\n\`\`\`json\n${JSON.stringify(webhookPayload, null, 2)}\n\`\`\``
        : '';

      if (job.action_type === "pi_command") {
        // Map /cog-X commands to their skill instructions directly
        const cmd = data.command as string;
        const skillMatch = cmd.match(/^\/cog-(\w+)$/);
        if (skillMatch) {
          const skill = skillMatch[1];
          const skillFile = path.join(cogCommandsDir, `${skill}.md`);
          try {
            const skillInstructions = await fs.readFile(skillFile, "utf-8");
            pi.sendUserMessage(
              `Please execute the following COG pipeline skill. Memory root: \`${cogMemoryRoot}\`${webhookContext}\n\n---\n\n${skillInstructions}`,
              { deliverAs: "followUp" }
            );
          } catch (err) {
            logger.debug("Skill file not found, using plain command", { skillFile, error: err });
            pi.sendUserMessage(`Run COG skill: ${cmd}${webhookContext}`, { deliverAs: "followUp" });
          }
        } else {
          pi.sendUserMessage(`${cmd}${webhookContext}`, { deliverAs: "followUp" });
        }
      } else if (job.action_type === "agent_prompt") {
        pi.sendUserMessage(`${data.message}${webhookContext}`, { deliverAs: "followUp" });
      } else if (job.action_type === "workflow") {
        // data = { workflow_name: string, inputs: Record<string, unknown> }
        // Trigger via pi.sendUserMessage to invoke run_workflow tool
        const inputs = { ...(data.inputs ?? {}), webhook_payload: webhookPayload };
        pi.sendUserMessage(
          `Please run the workflow '${data.workflow_name}' with these inputs: ${JSON.stringify(inputs)}${webhookContext}`,
          { deliverAs: "followUp" }
        );
      }
      // "webhook" type is triggered from HTTP, not cron
    };

    // Bootstrap and start jobs — single session, always run
    ensureCogJobs();
    startAllJobs();

    // Listen for webhook triggers from web server
    try {
      const webEvents = getGlobalWebEvents();
      webEvents.on('webhook:trigger', async ({ jobId, payload }: { jobId: string; payload: unknown }) => {
        logger.info("Webhook trigger received", { jobId, payload });
        try {
          const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND enabled = 1").get(jobId) as ScheduledJob | undefined;
          if (!job) {
            logger.warn("Webhook trigger for unknown or disabled job", { jobId });
            return;
          }
          
          // Execute the job with webhook context
          await executeJob(job, payload);
          db.prepare("INSERT INTO runs (job_id, ran_at, success) VALUES (?, datetime('now'), 1)").run(jobId);
        } catch (err) {
          logger.error("Webhook-triggered job failed", { jobId, error: err });
          db.prepare("INSERT INTO runs (job_id, ran_at, success, error) VALUES (?, datetime('now'), 0, ?)").run(jobId, String(err));
        }
      });
    } catch (err) {
      logger.debug("Web events not available yet (will be initialized by service.ts)", { error: err });
    }

    pi.on("session_shutdown", async () => {
      for (const task of activeTasks.values()) task.stop();
      activeTasks.clear();
      db.close();
    });

    // ── register_schedule tool ───────────────────────────────────────────────

    pi.registerTool({
      name: "register_schedule",
      label: "Register Schedule",
      description: "Register a new scheduled job — cron-based or webhook-triggered. action_type: agent_prompt (send message), pi_command (slash command), or workflow (run a named workflow). trigger_type: 'cron' (default, scheduled) or 'webhook' (HTTP-triggered). Returns the job ID and webhook URL if applicable.",
      promptSnippet: "Register a cron-scheduled job or webhook-triggered workflow",
      parameters: Type.Object({
        id: Type.String({ description: "Unique job ID, e.g. 'morning-brief'" }),
        cron: Type.Optional(Type.String({ description: "Cron expression e.g. '0 8 * * *' (8am daily). Optional for webhook jobs." })),
        action_type: Type.Union([
          Type.Literal("agent_prompt"),
          Type.Literal("pi_command"),
          Type.Literal("workflow"),
        ]),
        trigger_type: Type.Optional(Type.Union([
          Type.Literal("cron"),
          Type.Literal("webhook"),
        ], { description: "Trigger type: 'cron' (scheduled) or 'webhook' (HTTP POST). Defaults to 'cron'." })),
        message: Type.Optional(Type.String({ description: "Message to send (for agent_prompt)" })),
        command: Type.Optional(Type.String({ description: "Command to run (for pi_command)" })),
        workflow_name: Type.Optional(Type.String({ description: "Workflow name to run (for workflow action_type)" })),
        workflow_inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Input params for the workflow" })),
      }),

      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        const triggerType = params.trigger_type ?? 'cron';
        
        // Validate cron expression if trigger_type is 'cron' or not specified
        if (triggerType === 'cron') {
          if (!params.cron) {
            return {
              content: [{ type: "text", text: "❌ cron expression is required for cron-triggered jobs" }],
              details: {},
            };
          }
          if (!cron.validate(params.cron)) {
            return {
              content: [{ type: "text", text: `❌ Invalid cron expression: '${params.cron}'` }],
              details: {},
            };
          }
        }

        // Validate workflow exists if action_type is workflow
        if (params.action_type === "workflow") {
          if (!params.workflow_name) {
            return {
              content: [{ type: "text", text: "❌ workflow_name is required for workflow action_type" }],
              details: {},
            };
          }

          const resolvedWorkflowsDir = workflowsDir ?? path.join(projectRoot, "workflows");
          const workflowFile = path.join(resolvedWorkflowsDir, `${params.workflow_name}.yaml`);
          
          try {
            await fs.access(workflowFile);
          } catch (err) {
            return {
              content: [{ type: "text", text: `❌ Workflow '${params.workflow_name}' not found at ${workflowFile}` }],
              details: {},
            };
          }
        }

        let actionData: string;
        if (params.action_type === "pi_command") {
          actionData = JSON.stringify({ command: params.command });
        } else if (params.action_type === "workflow") {
          actionData = JSON.stringify({ workflow_name: params.workflow_name, inputs: params.workflow_inputs ?? {} });
        } else {
          actionData = JSON.stringify({ message: params.message });
        }

        try {
          const cronValue = params.cron ?? ''; // Allow empty cron for webhook jobs
          
          db.prepare(`
            INSERT OR REPLACE INTO jobs (id, cron, action_type, action_data, enabled, created_at, trigger_type)
            VALUES (?, ?, ?, ?, 1, datetime('now'), ?)
          `).run(params.id, cronValue, params.action_type, actionData, triggerType);

          const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(params.id) as ScheduledJob;
          startJob(job);

          const domain = getDomain();
          const webhookUrl = triggerType === 'webhook' ? `https://${domain}/webhooks/jobs/${params.id}` : undefined;
          
          const message = triggerType === 'webhook'
            ? `✓ Webhook job registered: '${params.id}'\nWebhook URL: ${webhookUrl}`
            : `✓ Schedule registered: '${params.id}' (${params.cron})`;

          return {
            content: [{ type: "text", text: message }],
            details: { 
              id: params.id, 
              cron: params.cron,
              trigger_type: triggerType,
              webhook_url: webhookUrl,
            },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Failed to register schedule: ${err}` }],
            details: {},
          };
        }
      },
    });

    // ── list_schedules tool ──────────────────────────────────────────────────

    pi.registerTool({
      name: "list_schedules",
      label: "List Schedules",
      description: "List all scheduled jobs, their trigger types, and cron expressions or webhook URLs.",
      promptSnippet: "List all scheduled jobs",
      parameters: Type.Object({}),

      async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
        const jobs = db.prepare("SELECT * FROM jobs ORDER BY id").all() as ScheduledJob[];

        if (jobs.length === 0) {
          return {
            content: [{ type: "text", text: "No scheduled jobs. Use register_schedule to add one." }],
            details: { jobs: [] },
          };
        }

        const domain = getDomain();
        const text = jobs.map(j => {
          const data = JSON.parse(j.action_data);
          const action = j.action_type === "pi_command" ? data.command : 
                        j.action_type === "workflow" ? `workflow: ${data.workflow_name}` :
                        `"${data.message}"`;
          const status = j.enabled ? "✓" : "✗";
          const triggerType = j.trigger_type ?? 'cron';
          const trigger = triggerType === 'webhook' 
            ? `🔗 webhook: https://${domain}/webhooks/jobs/${j.id}`
            : `⏰ cron: \`${j.cron}\``;
          return `${status} **${j.id}** — ${trigger} → ${action}`;
        }).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { jobs },
        };
      },
    });

    // ── COG pipeline commands ────────────────────────────────────────────────

    const runCogSkill = async (skill: string, ctx: { ui: { notify: (msg: string, type?: "info" | "warning" | "error") => void } }) => {
      const skillFile = path.join(cogCommandsDir, `${skill}.md`);

      let skillInstructions: string;
      try {
        skillInstructions = await fs.readFile(skillFile, "utf-8");
      } catch (err) {
        logger.debug("Skill file not found", { skillFile, error: err });
        ctx.ui.notify(`Skill file .claude/commands/${skill}.md not found`, "error");
        return;
      }

      ctx.ui.notify(`Starting /cog-${skill}…`, "info");

      pi.sendUserMessage(
        `Please execute the following COG pipeline skill. Memory root: \`${cogMemoryRoot}\`\n\n---\n\n${skillInstructions}`,
        { deliverAs: "followUp" }
      );
    };

    pi.registerCommand("cog-foresight", {
      description: "Run COG /foresight — generate today's cross-domain strategic nudge",
      handler: async (_args, ctx) => runCogSkill("foresight", ctx),
    });

    pi.registerCommand("cog-reflect", {
      description: "Run COG /reflect — mine session transcripts and condense patterns",
      handler: async (_args, ctx) => runCogSkill("reflect", ctx),
    });

    pi.registerCommand("cog-housekeeping", {
      description: "Run COG /housekeeping — archive stale data, rebuild indexes, audit links",
      handler: async (_args, ctx) => runCogSkill("housekeeping", ctx),
    });

    pi.registerCommand("cog-evolve", {
      description: "Run COG /evolve — audit Majordomo's architecture and propose improvements",
      handler: async (_args, ctx) => runCogSkill("evolve", ctx),
    });

    // ── /obsidian-daily command ──────────────────────────────────────────────

    pi.registerCommand("obsidian-daily", {
      description: "Build and write daily journal to Obsidian vault",
      handler: async (_args, ctx) => {
        const { getVaultRoot, writeDailyJournal } = await import("../../lib/obsidian.ts");
        const vaultRoot = getVaultRoot();
        
        if (!vaultRoot) {
          ctx.ui.notify("OBSIDIAN_VAULT not configured — integration disabled", "warning");
          return;
        }

        ctx.ui.notify("Building daily journal for Obsidian...", "info");

        try {
          const result = writeDailyJournal(cogMemoryRoot);
          if (result) {
            ctx.ui.notify(
              `✓ Daily journal written: ${result.path}`,
              "info"
            );
          } else {
            ctx.ui.notify("Failed to write daily journal (vault not configured)", "error");
          }
        } catch (err) {
          const message = formatError(err);
          ctx.ui.notify(`✗ Failed to write daily journal: ${message}`, "error");
        }
      },
    });

    // ── /switch command ──────────────────────────────────────────────────────

    pi.registerCommand("switch", {
      description: "Switch to a different domain context",
      handler: async (args, ctx) => {
        const domainId = args?.trim();
        if (!domainId) {
          ctx.ui.notify("Usage: /switch <domain-id>", "info");
          return;
        }

        const manager = getGlobalManager();
        try {
          await manager.switchDomain(domainId);
          ctx.ui.notify(`Switched to domain: ${domainId}`, "info");
          pi.sendUserMessage(
            `Domain context switched to ${domainId}. Loading relevant context...`,
            { deliverAs: "followUp" }
          );
        } catch (err) {
          ctx.ui.notify(`Failed to switch domain: ${err}`, "error");
        }
      },
    });
  };
}

// ── Default export ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const projectRoot = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
  const getDomain = () => process.env.MAJORDOMO_DOMAIN ?? "general";
  schedulerExtensionFactory({
    projectRoot,
    dataRoot: path.join(projectRoot, "data"),
    agentsDir: path.join(projectRoot, "agents"),
    getDomain,
  })(pi);
}
