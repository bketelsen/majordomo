/**
 * Schedules widget plugin - server-side logic
 */

import type { WidgetPlugin } from "../../src/types.ts";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import "../../../shared/types.ts";

const HOME = process.env.HOME ?? "/root";
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");
const DATA_ROOT = path.join(MAJORDOMO_STATE, "data");

export const plugin: WidgetPlugin = {
  async register(app, ctx) {
    app.post(`/api/schedules/:id/trigger`, async (c: any) => {
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
          // Resolve /cog-X commands to their skill instructions
          const cmd = data.command as string;
          const skillMatch = cmd.match(/^\/cog-(\w+)$/);
          if (skillMatch) {
            // Find skill file — check source tree locations
            const projectRoot = (process.env.MAJORDOMO_HOME
              ? path.join(process.env.MAJORDOMO_HOME, "current")
              : process.cwd());
            const skillFile = path.join(projectRoot, ".claude", "commands", `${skillMatch[1]}.md`);
            try {
              const instructions = await fs.readFile(skillFile, "utf-8");
              msg = `Please execute the following COG pipeline skill. Memory root: \`${path.join(MAJORDOMO_STATE, "memory")}\`\n\n---\n\n${instructions}`;
            } catch {
              msg = cmd; // fallback
            }
          } else {
            msg = cmd;
          }
        } else {
          msg = data.message;
        }

        manager.sendMessage(msg).catch((err) => {
          console.error("[schedules] trigger sendMessage failed:", err);
        });
        return c.json({ triggered: true, job: jobId });
      } catch (err) {
        console.error("[schedules] Failed to trigger job:", err);
        return c.json({ error: String(err) }, 500);
      }
    });
  },

  async getData(_ctx: any) {
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
  },
};
