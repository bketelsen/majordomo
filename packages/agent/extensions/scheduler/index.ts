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
import { type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  projectRoot: string;
  dataRoot: string;
  agentsDir: string;
  domain?: string;  // Deprecated: only the 'general' session starts cron ticks
  getDomain?: () => string;  // Dynamic domain accessor
}

interface ScheduledJob {
  id: string;
  cron: string;
  action_type: "pi_command" | "agent_prompt" | "webhook";
  action_data: string; // JSON
  enabled: number;     // 0 or 1
  created_at: string;
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
];

// ── DB schema ─────────────────────────────────────────────────────────────────

function openDb(dataRoot: string): Database {
  const dbPath = path.join(dataRoot, "scheduler.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      cron        TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_data TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT NOT NULL,
      ran_at     TEXT NOT NULL,
      success    INTEGER NOT NULL,
      error      TEXT
    );
  `);

  return db;
}

// ── Extension factory ─────────────────────────────────────────────────────────

export function schedulerExtensionFactory(opts: SchedulerOptions) {
  return (pi: ExtensionAPI) => {
    const { projectRoot, dataRoot } = opts;
    // Resolve domain: getDomain accessor takes precedence over static domain
    const getDomain = opts.getDomain ?? (() => opts.domain ?? "general");
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

      console.log(`[scheduler] Started ${activeTasks.size} job(s)`);
    };

    const startJob = (job: ScheduledJob) => {
      if (activeTasks.has(job.id)) return;

      if (!cron.validate(job.cron)) {
        console.warn(`[scheduler] Invalid cron expression for job '${job.id}': ${job.cron}`);
        return;
      }

      const task = cron.schedule(job.cron, async () => {
        console.log(`[scheduler] Running job '${job.id}'`);
        try {
          await executeJob(job);
          db.prepare("INSERT INTO runs (job_id, ran_at, success) VALUES (?, datetime('now'), 1)").run(job.id);
        } catch (err) {
          console.error(`[scheduler] Job '${job.id}' failed:`, err);
          db.prepare("INSERT INTO runs (job_id, ran_at, success, error) VALUES (?, datetime('now'), 0, ?)").run(job.id, String(err));
        }
      }, { timezone: process.env.TZ ?? "America/New_York" });

      activeTasks.set(job.id, task);
    };

    const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(process.env.HOME ?? "/root", ".majordomo");
    const cogMemoryRoot = path.join(MAJORDOMO_STATE, "memory");
    const cogCommandsDir = path.join(projectRoot, ".claude", "commands");

    const executeJob = async (job: ScheduledJob) => {
      const data = JSON.parse(job.action_data);

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
              `Please execute the following COG pipeline skill. Memory root: \`${cogMemoryRoot}\`\n\n---\n\n${skillInstructions}`,
              { deliverAs: "followUp" }
            );
          } catch {
            pi.sendUserMessage(`Run COG skill: ${cmd}`, { deliverAs: "followUp" });
          }
        } else {
          pi.sendUserMessage(cmd, { deliverAs: "followUp" });
        }
      } else if (job.action_type === "agent_prompt") {
        pi.sendUserMessage(data.message, { deliverAs: "followUp" });
      }
      // "webhook" type is triggered from HTTP, not cron
    };

    // Bootstrap and start jobs — single session, always run
    ensureCogJobs();
    startAllJobs();

    pi.on("session_shutdown", async () => {
      for (const task of activeTasks.values()) task.stop();
      activeTasks.clear();
      db.close();
    });

    // ── register_schedule tool ───────────────────────────────────────────────

    pi.registerTool({
      name: "register_schedule",
      label: "Register Schedule",
      description: "Register a new scheduled job — cron-based or persistent. Returns the job ID.",
      promptSnippet: "Register a cron-scheduled job or recurring reminder",
      parameters: Type.Object({
        id: Type.String({ description: "Unique job ID, e.g. 'morning-brief'" }),
        cron: Type.String({ description: "Cron expression e.g. '0 8 * * *' (8am daily)" }),
        action_type: Type.Union([
          Type.Literal("agent_prompt"),
          Type.Literal("pi_command"),
        ]),
        message: Type.Optional(Type.String({ description: "Message to send (for agent_prompt)" })),
        command: Type.Optional(Type.String({ description: "Command to run (for pi_command)" })),
      }),

      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        if (!cron.validate(params.cron)) {
          return {
            content: [{ type: "text", text: `❌ Invalid cron expression: '${params.cron}'` }],
            details: {},
          };
        }

        const actionData = params.action_type === "pi_command"
          ? JSON.stringify({ command: params.command })
          : JSON.stringify({ message: params.message });

        try {
          db.prepare(`
            INSERT OR REPLACE INTO jobs (id, cron, action_type, action_data, enabled, created_at)
            VALUES (?, ?, ?, ?, 1, datetime('now'))
          `).run(params.id, params.cron, params.action_type, actionData);

          const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(params.id) as ScheduledJob;
          startJob(job);

          return {
            content: [{ type: "text", text: `✓ Schedule registered: '${params.id}' (${params.cron})` }],
            details: { id: params.id, cron: params.cron },
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
      description: "List all scheduled jobs and their cron expressions.",
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

        const text = jobs.map(j => {
          const data = JSON.parse(j.action_data);
          const action = j.action_type === "pi_command" ? data.command : `"${data.message}"`;
          const status = j.enabled ? "✓" : "✗";
          return `${status} **${j.id}** — \`${j.cron}\` → ${action}`;
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
      } catch {
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

    // ── /switch command ──────────────────────────────────────────────────────

    pi.registerCommand("switch", {
      description: "Switch to a different domain context",
      handler: async (args, ctx) => {
        const domainId = args?.trim();
        if (!domainId) {
          ctx.ui.notify("Usage: /switch <domain-id>", "info");
          return;
        }

        const manager = (globalThis as any).__majordomoManager;
        if (manager) {
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
        } else {
          console.log(`[switch] Intent logged: switch to domain '${domainId}' (manager not wired yet)`);
          ctx.ui.notify(
            `Domain switch intent logged: ${domainId} (DomainContextManager not wired yet)`,
            "info"
          );
        }
      },
    });
  };
}

// ── Default export ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const projectRoot = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
  schedulerExtensionFactory({
    projectRoot,
    dataRoot: path.join(projectRoot, "data"),
    agentsDir: path.join(projectRoot, "agents"),
    domain: process.env.MAJORDOMO_DOMAIN ?? "general",
  })(pi);
}
