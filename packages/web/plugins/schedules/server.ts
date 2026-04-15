/**
 * Schedules widget plugin - server-side logic
 * 
 * Displays scheduled jobs and allows triggering them manually
 */

import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";
import { Database } from "bun:sqlite";
import * as path from "node:path";

export const plugin: WidgetPlugin = {
  async register(app, ctx) {
    // Register trigger endpoint for manually running scheduled jobs
    app.post(`/api/schedules/:id/trigger`, async (c) => {
      const jobId = c.req.param("id");
      
      // Access the agent service manager
      const manager = (globalThis as Record<string, unknown>).__majordomoManager as {
        switchDomain: (domain: string) => Promise<void>;
        sendMessage: (t: string) => Promise<string>;
      } | undefined;
      
      if (!manager) {
        return c.json({ error: "Agent not available" }, 503);
      }
      
      // Get job details from database
      const dataRoot = path.dirname(path.dirname(ctx.dataDir));
      const dbPath = path.join(dataRoot, "scheduler.db");
      
      try {
        const db = new Database(dbPath, { readonly: true });
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
        db.close();
        
        if (!job) {
          return c.json({ error: "Job not found" }, 404);
        }
        
        const data = JSON.parse(job.action_data as string);
        const msg = job.action_type === "pi_command" ? data.command : data.message;
        
        // Trigger the job by sending it to the general domain
        await manager.switchDomain("general");
        manager.sendMessage(msg).catch(() => {});
        
        return c.json({ triggered: true, job: jobId });
      } catch (err) {
        console.error("[schedules] Failed to trigger job:", err);
        return c.json({ error: String(err) }, 500);
      }
    });
  },

  async getData(ctx) {
    // Access the shared scheduler database
    const dataRoot = path.dirname(path.dirname(ctx.dataDir));
    const dbPath = path.join(dataRoot, "scheduler.db");
    
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
            try {
              const d = JSON.parse(j.action_data as string);
              return d.command ?? d.message ?? String(j.action_data);
            } catch {
              return String(j.action_data);
            }
          })(),
          enabled: Boolean(j.enabled),
          lastRan: j.last_ran ?? null,
          runCount: j.run_count ?? 0,
        })),
        updatedAt: Date.now(),
        meta: {
          total: jobs.length,
          enabled: jobs.filter(j => j.enabled).length,
        },
      };
    } catch (err) {
      console.error("[schedules] Failed to query database:", err);
      return {
        jobs: [],
        updatedAt: Date.now(),
        meta: { error: String(err) },
      };
    }
  },
};
