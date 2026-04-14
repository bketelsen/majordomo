#!/usr/bin/env bun
/**
 * migrate-sessions.ts
 *
 * Merges per-domain JSONL session files into a single unified session.jsonl.
 * Non-destructive: leaves originals in .archive/ folder.
 *
 * Usage:
 *   bun packages/agent/scripts/migrate-sessions.ts
 *   MAJORDOMO_DATA_ROOT=/custom/path bun packages/agent/scripts/migrate-sessions.ts
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

interface SessionMessage {
  timestamp: string;
  metadata?: { domain?: string; [key: string]: any };
  [key: string]: any;
}

async function migrateSessionHistory(dataRoot: string): Promise<void> {
  console.log("[migrate] Starting session history migration...");
  console.log(`[migrate] Data root: ${dataRoot}`);

  const sessionDir = path.join(dataRoot, "sessions");

  // Check if session dir exists
  try {
    await fs.access(sessionDir);
  } catch {
    console.error(`[migrate] Sessions directory not found: ${sessionDir}`);
    console.log("[migrate] Nothing to migrate - exiting");
    return;
  }

  // Find all domain directories (exclude dotfiles and unified dir)
  const entries = await fs.readdir(sessionDir, { withFileTypes: true });
  const domainDirs = entries.filter(
    (e) =>
      e.isDirectory() &&
      !e.name.startsWith(".") &&
      e.name !== "unified"
  );

  if (domainDirs.length === 0) {
    console.log("[migrate] No domain directories found to migrate");
    return;
  }

  console.log(`[migrate] Found ${domainDirs.length} domain directory(ies): ${domainDirs.map(d => d.name).join(", ")}`);

  const allMessages: SessionMessage[] = [];
  const stats: Record<string, number> = {};

  // Read messages from each domain
  for (const dir of domainDirs) {
    const domainId = dir.name;
    const sessionFile = path.join(sessionDir, domainId, "session.jsonl");

    try {
      console.log(`[migrate] Reading ${domainId}/session.jsonl...`);
      const content = await fs.readFile(sessionFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      let messageCount = 0;
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as SessionMessage;
          // Tag with domain metadata
          msg.metadata = { ...msg.metadata, domain: domainId };
          allMessages.push(msg);
          messageCount++;
        } catch (err) {
          console.warn(`[migrate] Skipping invalid JSON line in ${domainId}: ${err}`);
        }
      }

      stats[domainId] = messageCount;
      console.log(`[migrate]   → ${messageCount} message(s) from ${domainId}`);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        console.log(`[migrate]   → ${domainId}/session.jsonl not found (empty domain)`);
        stats[domainId] = 0;
      } else {
        console.warn(`[migrate]   → Could not read ${domainId}/session.jsonl:`, err.message);
        stats[domainId] = 0;
      }
    }
  }

  if (allMessages.length === 0) {
    console.log("[migrate] No messages found to migrate");
    return;
  }

  // Sort by timestamp
  console.log(`[migrate] Sorting ${allMessages.length} message(s) by timestamp...`);
  allMessages.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeA - timeB;
  });

  // Write unified session file
  const unifiedFile = path.join(sessionDir, "session.jsonl");
  const content = allMessages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";

  console.log(`[migrate] Writing unified session file: session.jsonl`);
  await fs.writeFile(unifiedFile, content, "utf-8");

  console.log(`[migrate] ✓ Written ${allMessages.length} message(s) to session.jsonl`);

  // Archive old per-domain directories
  const archiveRoot = path.join(sessionDir, ".archive");
  await fs.mkdir(archiveRoot, { recursive: true });

  console.log(`[migrate] Archiving per-domain session directories...`);
  for (const dir of domainDirs) {
    const src = path.join(sessionDir, dir.name);
    const dst = path.join(archiveRoot, dir.name);

    try {
      await fs.rename(src, dst);
      console.log(`[migrate]   → ${dir.name}/ → .archive/${dir.name}/`);
    } catch (err: any) {
      console.warn(`[migrate]   → Could not archive ${dir.name}:`, err.message);
    }
  }

  console.log("\n[migrate] ════════════════════════════════════════════════════════");
  console.log("[migrate] Migration complete!");
  console.log("[migrate] ════════════════════════════════════════════════════════");
  console.log(`[migrate] Total messages: ${allMessages.length}`);
  console.log(`[migrate] Domains merged: ${domainDirs.length}`);
  console.log("[migrate]");
  console.log("[migrate] Breakdown by domain:");
  for (const [domain, count] of Object.entries(stats)) {
    console.log(`[migrate]   ${domain}: ${count} message(s)`);
  }
  console.log("[migrate]");
  console.log(`[migrate] Unified file: ${unifiedFile}`);
  console.log(`[migrate] Archived:     ${archiveRoot}/`);
  console.log("[migrate] ════════════════════════════════════════════════════════\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const dataRoot =
    process.env.MAJORDOMO_DATA_ROOT ??
    path.join(process.env.HOME!, ".majordomo", "data");

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Majordomo Session Migration Script");
  console.log("  Merges per-domain sessions into unified session.jsonl");
  console.log("════════════════════════════════════════════════════════\n");

  migrateSessionHistory(dataRoot)
    .then(() => {
      console.log("[migrate] Script completed successfully");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[migrate] Migration failed:", err);
      process.exit(1);
    });
}
