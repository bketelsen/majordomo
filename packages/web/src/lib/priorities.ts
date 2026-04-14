/**
 * Priorities write-back — marks a COG action item done directly from the dashboard.
 * Replicates the cog_update_action_item "complete" logic without going through the LLM.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function markPriorityDone(
  memoryRoot: string,
  domain: string,
  taskMatch: string   // substring of the task text to match
): Promise<{ ok: boolean; error?: string }> {
  const filePath = path.join(memoryRoot, domain, "action-items.md");

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { ok: false, error: `action-items.md not found for domain '${domain}'` };
  }

  const lines = content.split("\n");
  let matched = false;

  const updated = lines.map((line) => {
    if (matched) return line;
    // Only match open items: "- [ ] ..."
    if (!line.startsWith("- [ ]")) return line;
    // Check if this line contains the task match text (case-insensitive)
    const taskPart = line.slice(5).split(" | ")[0].trim();
    if (!taskPart.toLowerCase().includes(taskMatch.toLowerCase())) return line;
    matched = true;
    return `- [x] ${taskPart} (done ${today()})`;
  });

  if (!matched) {
    return { ok: false, error: `No open task matching '${taskMatch}' found in ${domain}/action-items.md` };
  }

  await fs.writeFile(filePath, updated.join("\n"), "utf-8");
  return { ok: true };
}
