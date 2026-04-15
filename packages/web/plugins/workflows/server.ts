/**
 * Workflow status widget plugin - server-side logic
 */

import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";
import { Database } from "bun:sqlite";
import * as path from "node:path";

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

export const plugin: WidgetPlugin = {
  async getData(ctx: WidgetContext) {
    // Access shared subagents.db (same as subagents plugin)
    const dataRoot = path.dirname(path.dirname(ctx.dataDir));
    const dbPath = path.join(dataRoot, "subagents.db");
    
    try {
      const db = new Database(dbPath, { readonly: true });
      
      // Enable FK enforcement even in readonly mode (does nothing but good practice)
      db.exec("PRAGMA foreign_keys = ON");
      
      const maxWorkflows = (ctx.config.maxWorkflows as number) ?? 10;
      
      // Get unique workflows
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
      console.error("[workflows] Failed to query database:", err);
      return { 
        workflows: [], 
        updatedAt: Date.now(),
        meta: { error: String(err) },
      };
    }
  },
};
