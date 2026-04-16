/**
 * Mentat Integration Utilities
 *
 * Provides integration with the Mentat CLI tool (frostyard/mentat) which
 * maintains the .agentic/ harness for AI process artifacts.
 *
 * Functions:
 *   - isMentatAvailable() — check if mentat CLI is installed
 *   - hasAgenticHarness() — check if repo has .agentic/ directory
 *   - mentatInit() — initialize .agentic/ harness in a repo
 *   - mentatSync() — refresh skills and MAP.md after structural changes
 */

import { which } from "bun";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createLogger } from "./logger.ts";

const logger = createLogger({ context: { component: "mentat" } });

/**
 * Check if the mentat CLI is available on the system
 */
export async function isMentatAvailable(): Promise<boolean> {
  try {
    await which("mentat");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a repository has the .agentic/ harness initialized
 */
export async function hasAgenticHarness(repoPath: string): Promise<boolean> {
  const readmePath = path.join(repoPath, ".agentic", "README.md");
  return existsSync(readmePath);
}

/**
 * Get .agentic/ context injection string for agent prompts (Wave 4)
 * 
 * Returns a brief note about available artifacts plus a preview of MAP.md.
 * Agents read the full artifacts on-demand; this is just the index.
 */
export async function getAgenticContext(repoPath: string): Promise<string | null> {
  if (!await hasAgenticHarness(repoPath)) return null;
  
  const parts: string[] = [];
  
  // Check if README.md exists
  const readmePath = path.join(repoPath, ".agentic", "README.md");
  if (existsSync(readmePath)) {
    parts.push("This repo has a .agentic/ harness with practice artifacts:");
    parts.push("- .agentic/prds/ — product requirements (read before implementing features)");
    parts.push("- .agentic/arch/ — architecture decisions (read before designing)");
    parts.push("- .agentic/plans/ — implementation plans");
    parts.push("- .agentic/tests/ — test specs (write these BEFORE implementing)");
    parts.push("- .agentic/contexts/MAP.md — codebase navigation guide");
  }
  
  // Include first 50 lines of MAP.md if it exists
  const mapPath = path.join(repoPath, ".agentic", "contexts", "MAP.md");
  if (existsSync(mapPath)) {
    try {
      const { readFileSync } = await import("node:fs");
      const mapContent = readFileSync(mapPath, "utf-8");
      const mapPreview = mapContent.split("\n").slice(0, 50).join("\n");
      parts.push("\n## Codebase Map (from .agentic/contexts/MAP.md)");
      parts.push(mapPreview);
      if (mapContent.split("\n").length > 50) {
        parts.push("\n(... read full .agentic/contexts/MAP.md for complete details)");
      }
    } catch (err) {
      logger.debug("Failed to read MAP.md", { mapPath, error: err });
    }
  }
  
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Initialize the .agentic/ harness in a repository
 * Calls `mentat init` in the repo directory
 */
export async function mentatInit(repoPath: string): Promise<void> {
  logger.info("Initializing .agentic/ harness", { repoPath });
  
  const result = Bun.spawnSync(["mentat", "init"], {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    logger.warn("mentat init failed", { repoPath, stderr, exitCode: result.exitCode });
    console.warn("[mentat] init failed:", stderr);
  } else {
    const stdout = result.stdout.toString();
    logger.info("mentat init succeeded", { repoPath });
    console.log("[mentat] .agentic/ initialized");
    if (stdout) console.log(stdout);
  }
}

/**
 * Sync the .agentic/ harness (refresh skills and MAP.md)
 * Calls `mentat sync` in the repo directory
 * 
 * Should be called after structural code changes:
 * - File/directory reorganization
 * - Module consolidation
 * - Dead code removal
 * - Architecture changes
 */
export async function mentatSync(repoPath: string): Promise<void> {
  logger.info("Syncing .agentic/ harness", { repoPath });
  
  const result = Bun.spawnSync(["mentat", "sync"], {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    logger.warn("mentat sync failed", { repoPath, stderr, exitCode: result.exitCode });
    console.warn("[mentat] sync failed:", stderr);
  } else {
    const stdout = result.stdout.toString();
    logger.info("mentat sync succeeded", { repoPath });
    console.log("[mentat] skills + MAP.md refreshed");
    if (stdout) console.log(stdout);
  }
}
