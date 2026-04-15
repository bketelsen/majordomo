/**
 * Priorities widget plugin - server-side logic
 * 
 * Reads action-items.md from all active domains and returns critical/high priority items.
 */

import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { markPriorityDone } from "../../src/lib/priorities.ts";

const HOME = process.env.HOME ?? "/root";
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");
const MEMORY_ROOT = path.join(MAJORDOMO_STATE, "memory");

interface Domain {
  id: string;
  path: string;
  type: string;
  label: string;
  triggers: string[];
  status?: string;
}

interface PriorityItem {
  domain: string;
  task: string;
  priority: string;
  due?: string;
}

async function readDomains(): Promise<Domain[]> {
  const filePath = path.join(MEMORY_ROOT, "domains.yml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const manifest = yaml.load(content) as { domains: Domain[] };
    return (manifest.domains ?? []).filter(d => d.status !== "archived");
  } catch {
    return [];
  }
}

async function computePriorities(): Promise<PriorityItem[]> {
  const domains = await readDomains();
  const priorities: PriorityItem[] = [];

  for (const domain of domains) {
    const filePath = path.join(MEMORY_ROOT, domain.path, "action-items.md");
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        // Match: - [ ] task | due:YYYY-MM-DD | pri:high | ...
        if (!line.startsWith("- [ ]")) continue;
        const taskText = line.slice(5).split(" | ")[0].trim();
        const priMatch = line.match(/\bpri:(critical|high|med|low)\b/);
        const dueMatch = line.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/);
        const priority = priMatch?.[1] ?? "med";
        if (priority === "critical" || priority === "high") {
          priorities.push({
            domain: domain.id,
            task: taskText,
            priority,
            due: dueMatch?.[1],
          });
        }
      }
    } catch { /* domain may not have action-items */ }
  }

  // Sort: critical first, then high, then by due date
  const priorityOrder = { critical: 0, high: 1, med: 2, low: 3 };
  priorities.sort((a, b) => {
    const po = (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2) -
               (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2);
    if (po !== 0) return po;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  return priorities;
}

export const plugin: WidgetPlugin = {
  async register(app, ctx) {
    // Register custom action endpoint for marking items done
    app.post(`/api/widgets/${ctx.id}/done`, async (c) => {
      const { domain, task } = await c.req.json();
      
      if (!domain || !task) {
        return c.json({ error: "domain and task required" }, 400);
      }
      
      const result = await markPriorityDone(MEMORY_ROOT, domain, task);
      
      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }
      
      return c.json({ ok: true });
    });
  },

  async getData(ctx) {
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
  },
};
