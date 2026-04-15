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
