/**
 * Priorities widget plugin - server-side logic
 * Self-contained: no external dependencies, no relative imports outside plugin dir.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readDomainsManifest, type CogDomain } from "../../../shared/lib/domains";

const HOME = process.env.HOME ?? "/root";
const MAJORDOMO_STATE = process.env.MAJORDOMO_STATE ?? path.join(HOME, ".majordomo");
const MEMORY_ROOT = path.join(MAJORDOMO_STATE, "memory");



interface PriorityItem {
  domain: string;
  task: string;
  priority: string;
  due?: string;
}

async function readDomains(): Promise<CogDomain[]> {
  const manifest = await readDomainsManifest(MEMORY_ROOT);
  return manifest.domains.filter(d => d.path && d.status !== "archived");
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

async function markDone(memoryRoot: string, domain: string, task: string): Promise<{ ok: boolean; error?: string }> {
  const filePath = path.join(memoryRoot, domain, "action-items.md");
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

export const plugin = {
  async register(app: any, ctx: any) {
    app.post(`/api/widgets/${ctx.id}/done`, async (c: any) => {
      const { domain, task } = await c.req.json();
      if (!domain || !task) return c.json({ error: "domain and task required" }, 400);
      const result = await markDone(MEMORY_ROOT, domain, task);
      return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 400);
    });
  },

  async getData(_ctx: any) {
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
