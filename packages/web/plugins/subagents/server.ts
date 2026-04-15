/**
 * Subagents widget plugin - server-side logic
 * 
 * Monitors subagent execution history from subagents.db
 */

import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";
import { Database } from "bun:sqlite";
import * as path from "node:path";

export const plugin: WidgetPlugin = {
  async getData(ctx) {
    // Access the shared subagents database
    const dataRoot = path.dirname(path.dirname(ctx.dataDir));
    const dbPath = path.join(dataRoot, "subagents.db");
    
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
      console.error("[subagents] Failed to query database:", err);
      return { 
        runs: [], 
        updatedAt: Date.now(),
        meta: { error: String(err) },
      };
    }
  },
};
