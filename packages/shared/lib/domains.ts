/**
 * Shared domains.yml manifest utilities
 * Consolidates domain manifest reading logic across agent, web, and plugins.
 */

import * as path from "node:path";
import { loadYamlFile } from "./yaml-helpers";

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
  return loadYamlFile<DomainsManifest>(filePath, { domains: [] });
}
