/**
 * Shared domains.yml manifest utilities
 * Consolidates domain manifest reading logic across agent, web, and plugins.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CogDomain {
  id: string;
  path: string;
  type: string;
  label: string;
  triggers: string[];
  files: string[];
  status?: "active" | "archived";
  created_at?: string;
  workingDir?: string;
}

export interface DomainsManifest {
  domains: CogDomain[];
}

// ── Read domains manifest ─────────────────────────────────────────────────────

/**
 * Read and parse domains.yml manifest from memory root.
 * Returns an empty domains array on error (file not found, parse error, etc).
 */
export async function readDomainsManifest(memoryRoot: string): Promise<DomainsManifest> {
  const filePath = path.join(memoryRoot, "domains.yml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return (yaml.load(content) as DomainsManifest) ?? { domains: [] };
  } catch {
    return { domains: [] };
  }
}
