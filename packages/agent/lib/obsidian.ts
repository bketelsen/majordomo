/**
 * Obsidian vault integration — write-only
 * 
 * Compiles daily journal notes from COG memory and writes them atomically
 * to the Obsidian vault.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "./logger.ts";

const logger = createLogger({ context: { component: "obsidian" } });

// ── Configuration ─────────────────────────────────────────────────────────────

export function getVaultRoot(): string | null {
  const vaultPath = process.env.OBSIDIAN_VAULT;
  if (!vaultPath) {
    logger.debug("OBSIDIAN_VAULT not configured, integration disabled");
    return null;
  }
  return vaultPath;
}

// ── Helper functions ──────────────────────────────────────────────────────────

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Walk memory/ and collect all files matching `filename` in any domain dir.
 */
function findMemoryFiles(
  memoryRoot: string,
  filename: string
): Array<{ file: string; domain: string }> {
  const results: Array<{ file: string; domain: string }> = [];

  function walk(dir: string, label: string, depth: number) {
    const f = path.join(dir, filename);
    if (fs.existsSync(f)) {
      results.push({ file: f, domain: label });
    }
    if (depth <= 0) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name), entry.name, depth - 1);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  walk(memoryRoot, "general", 2);
  return results;
}

/**
 * Extract observation lines dated `date` (format: `- YYYY-MM-DD [tags]: text`).
 */
function extractObservations(content: string, date: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.startsWith(`- ${date}`))
    .map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} \[[^\]]*\]: ?/, "").trim())
    .filter(Boolean);
}

/**
 * Extract completed action items marked `done YYYY-MM-DD`.
 */
function extractCompletedItems(content: string, date: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.includes(`(done ${date})`))
    .map((l) =>
      l.replace(/^- \[x\] /, "").replace(/\s*\(done [^)]+\)$/, "").trim()
    )
    .filter(Boolean);
}

/**
 * Extract open action items.
 */
function extractOpenItems(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.startsWith("- [ ]"))
    .map((l) => {
      const raw = l.replace(/^- \[ \] /, "").trim();
      return raw.split("|")[0].trim();
    })
    .filter(Boolean);
}

/**
 * Extract dev-log entries for `date` (header: `## YYYY-MM-DD` or `### YYYY-MM-DD`).
 */
function extractDevLog(content: string, date: string): string[] {
  const lines = content.split("\n");
  const results: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.match(/^#{2,3}\s+\d{4}-\d{2}-\d{2}/)) {
      capturing = line.includes(date);
      continue;
    }
    if (capturing && line.match(/^#{2,3}\s/)) {
      capturing = false;
    }
    if (capturing && line.trim()) {
      results.push(line.replace(/^#+\s*/, "").trim());
    }
  }

  return results.filter(Boolean);
}

/**
 * Extract calendar events for a given date.
 */
function extractCalendarEvents(content: string, date: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.includes(date) && l.trim().startsWith("-"))
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

// ── Journal builder ───────────────────────────────────────────────────────────

export interface BuildDailyNoteOptions {
  date?: string;
  domain?: string;
}

/**
 * Build the daily journal note from COG memory.
 * Assembles content from:
 * - hot-memory.md (Active Focus section)
 * - personal/calendar.md (or domain/calendar.md)
 * - observations.md across all domains
 * - dev-log.md entries for the date
 * - action-items.md (completed and open)
 * - cog-meta/foresight-nudge.md (if fresh)
 */
export function buildDailyNote(
  memoryRoot: string,
  opts: BuildDailyNoteOptions = {}
): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const domain = opts.domain ?? "personal";
  const sections: string[] = [];

  // YAML frontmatter
  sections.push(`---\ndate: ${date}\ntags: [journal, daily]\n---\n`);

  // Active Focus — from hot-memory
  const hotMem = readFile(path.join(memoryRoot, "hot-memory.md"));
  const focusMatch = hotMem.match(/##\s+Active.*?\n([\s\S]*?)(?:\n##|$)/);
  if (focusMatch) {
    const focus = focusMatch[1].trim();
    if (focus) {
      sections.push(`## Active Focus\n\n${focus}\n`);
    }
  }

  // Calendar events for today
  const calendarPath = path.join(memoryRoot, domain, "calendar.md");
  const calEvents = extractCalendarEvents(readFile(calendarPath), date);
  if (calEvents.length > 0) {
    sections.push(
      `## Calendar\n\n${calEvents.map((e) => `- ${e}`).join("\n")}\n`
    );
  }

  // What Happened Today — observations across all domains
  const obsFiles = findMemoryFiles(memoryRoot, "observations.md");
  const allObs: string[] = [];
  for (const { file, domain: obsDomain } of obsFiles) {
    const entries = extractObservations(readFile(file), date);
    for (const e of entries) {
      allObs.push(`- **[${obsDomain}]** ${e}`);
    }
  }
  // Also cog-meta self-observations
  const selfObs = extractObservations(
    readFile(path.join(memoryRoot, "cog-meta", "self-observations.md")),
    date
  );
  for (const e of selfObs) {
    allObs.push(`- **[cog]** ${e}`);
  }

  if (allObs.length > 0) {
    sections.push(`## What Happened Today\n\n${allObs.join("\n")}\n`);
  }

  // Work Done — dev-log entries
  const devLogFiles = findMemoryFiles(memoryRoot, "dev-log.md");
  const allDevLog: string[] = [];
  for (const { file, domain: devDomain } of devLogFiles) {
    const entries = extractDevLog(readFile(file), date);
    if (entries.length > 0) {
      allDevLog.push(`**${devDomain}**`);
      allDevLog.push(...entries.map((e) => `- ${e}`));
    }
  }
  if (allDevLog.length > 0) {
    sections.push(`## Work Done\n\n${allDevLog.join("\n")}\n`);
  }

  // Tasks Completed today
  const actionFiles = findMemoryFiles(memoryRoot, "action-items.md");
  const allDone: string[] = [];
  for (const { file } of actionFiles) {
    allDone.push(
      ...extractCompletedItems(readFile(file), date).map((t) => `- [x] ${t}`)
    );
  }
  if (allDone.length > 0) {
    sections.push(`## Completed\n\n${allDone.join("\n")}\n`);
  }

  // Open Tasks — top 10 across domains
  const allOpen: string[] = [];
  for (const { file, domain: actionDomain } of actionFiles) {
    const items = extractOpenItems(readFile(file));
    for (const t of items.slice(0, 5)) {
      allOpen.push(`- [ ] [${actionDomain}] ${t}`);
    }
  }
  if (allOpen.length > 0) {
    sections.push(`## Open Tasks\n\n${allOpen.slice(0, 10).join("\n")}\n`);
  }

  // Foresight nudge if fresh
  const nudgePath = path.join(memoryRoot, "cog-meta", "foresight-nudge.md");
  if (fs.existsSync(nudgePath)) {
    try {
      const mtime = fs.statSync(nudgePath).mtime.toISOString().slice(0, 10);
      if (mtime === date) {
        const raw = readFile(nudgePath);
        const nudgeLines = raw
          .split("\n")
          .filter(
            (l) => !l.startsWith("#") && !l.startsWith("<!--") && l.trim()
          );
        if (nudgeLines.length > 0) {
          sections.push(
            `## Foresight\n\n${nudgeLines.slice(0, 6).join("\n")}\n`
          );
        }
      }
    } catch {
      // skip
    }
  }

  return sections.join("\n");
}

// ── Vault writer ──────────────────────────────────────────────────────────────

export interface VaultWriteResult {
  /** Absolute path written (or skipped). */
  path: string;
  /** true = file did not exist before this call. */
  created: boolean;
  /** true = file already existed and overwrite was false — nothing was written. */
  skipped: boolean;
}

/**
 * Write `content` to `relPath` inside the Obsidian vault.
 * 
 * @param vaultRoot Absolute path to vault root
 * @param relPath   Vault-relative path, e.g. `"Personal/Research/topic.md"`.
 * @param content   Full Markdown content to write.
 * @param overwrite If false (default), returns `{ skipped: true }` when file exists.
 */
export function writeToVault(
  vaultRoot: string,
  relPath: string,
  content: string,
  overwrite = false
): VaultWriteResult {
  // Validate vault root exists
  if (!fs.existsSync(vaultRoot)) {
    throw new Error(`Obsidian vault not found: ${vaultRoot}`);
  }

  // Path-traversal guard: resolved path must be inside the vault root
  const absPath = path.resolve(vaultRoot, relPath);
  const resolvedVaultRoot = path.resolve(vaultRoot);
  
  if (
    !absPath.startsWith(resolvedVaultRoot + path.sep) &&
    absPath !== resolvedVaultRoot
  ) {
    throw new Error(
      `Path traversal detected: "${relPath}" resolves outside the vault root`
    );
  }

  const existed = fs.existsSync(absPath);

  if (existed && !overwrite) {
    return { path: absPath, created: false, skipped: true };
  }

  // Ensure parent directories exist
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // Atomic write: tmp → rename
  const tmpPath = `${absPath}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, absPath);

  logger.info("Obsidian vault file written", { path: absPath });
  return { path: absPath, created: !existed, skipped: false };
}

/**
 * Atomically write the daily journal note to the Obsidian vault.
 * Returns null if vault is not configured.
 */
export function writeDailyJournal(
  memoryRoot: string,
  opts: BuildDailyNoteOptions = {}
): { path: string; created: boolean } | null {
  const vaultRoot = getVaultRoot();
  if (!vaultRoot) {
    return null;
  }

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const [year, month] = date.split("-");
  const relPath = `Journal/${year}/${year}-${month}-${date.slice(-2)}.md`;

  const content = buildDailyNote(memoryRoot, opts);
  const result = writeToVault(vaultRoot, relPath, content, true);

  logger.info("Obsidian daily journal written", {
    path: result.path,
    date,
  });
  
  return { path: result.path, created: result.created };
}
