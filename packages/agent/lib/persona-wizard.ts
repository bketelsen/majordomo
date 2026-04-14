/**
 * First-run persona wizard.
 *
 * On service startup, checks if the user has personalized Majordomo.
 * "Personalized" = memory/hot-memory.md has real content beyond the bootstrap stub.
 *
 * If not, sends a welcome message to the general domain. Majordomo asks for
 * name, timezone, and working style, then writes the answers to
 * memory/hot-memory.md — the cross-domain always-read file that is injected
 * into every conversation.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

const HOT_MEMORY = "memory/hot-memory.md";
const WIZARD_SENTINEL = "<!-- wizard-complete -->";

const WIZARD_PROMPT = `# Welcome to Majordomo! 🏛

I'm your personal chief-of-staff. Before we get started, I'd like to learn a little about you so I can serve you well across all domains.

Please tell me:
1. **Your name** — what should I call you?
2. **Your timezone** — e.g. "America/New_York" or "Europe/Berlin"
3. **Your working style** — morning person or night owl? Prefer concise summaries or deep detail? Any communication preferences?
4. **Your top 2–3 priorities right now** — what are you focused on this month?

I'll save your answers to \`memory/hot-memory.md\` — the cross-domain file I read at the start of every conversation. You can update any of this later by just telling me.`;

export async function runPersonaWizardIfNeeded(
  projectRoot: string,
  sendToGeneral: (text: string) => Promise<string>
): Promise<void> {
  const hotMemoryPath = path.join(projectRoot, HOT_MEMORY);

  // Already personalized if hot-memory contains the wizard sentinel
  try {
    const content = await fs.readFile(hotMemoryPath, "utf-8");
    if (content.includes(WIZARD_SENTINEL)) return;

    // Also skip if hot-memory has substantial real content (>3 non-comment, non-empty lines)
    const meaningfulLines = content
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("<!--") && !l.startsWith("#") && l !== "*");
    if (meaningfulLines.length > 3) return;
  } catch {
    // hot-memory doesn't exist yet — proceed with wizard
  }

  // Wait for sessions to be fully ready before sending
  await new Promise(r => setTimeout(r, 3000));

  console.log("[wizard] First run — sending welcome message to general domain");

  try {
    await sendToGeneral(WIZARD_PROMPT);
  } catch (err) {
    console.warn("[wizard] Could not send welcome message:", err);
  }
}
