/**
 * Shared domains.yml manifest utilities
 * Consolidates domain manifest reading logic across agent, web, and plugins.
 */

import * as path from "node:path";
import { watch, type FSWatcher } from "node:fs";
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

// ── Cache with TTL and file watching ──────────────────────────────────────────

interface CacheEntry {
  manifest: DomainsManifest;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const watchers = new Map<string, FSWatcher>();
const CACHE_TTL = 5000; // 5 seconds

/**
 * Invalidate the cache for a specific memory root.
 * If no memoryRoot is provided, invalidates all cached entries.
 */
export function invalidateDomainsCache(memoryRoot?: string): void {
  if (memoryRoot) {
    cache.delete(memoryRoot);
  } else {
    cache.clear();
  }
}

/**
 * Set up file watcher for automatic cache invalidation.
 * Only creates one watcher per memoryRoot.
 */
function setupFileWatcher(memoryRoot: string): void {
  if (watchers.has(memoryRoot)) return;

  const domainsFile = path.join(memoryRoot, "domains.yml");
  
  try {
    const watcher = watch(domainsFile, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        invalidateDomainsCache(memoryRoot);
      }
    });
    
    watcher.on("error", () => {
      // Silently handle watcher errors (file might not exist yet)
      watchers.delete(memoryRoot);
    });
    
    watchers.set(memoryRoot, watcher);
  } catch {
    // Failed to set up watcher - cache will still work with TTL
  }
}

// ── Read domains manifest with caching ────────────────────────────────────────

/**
 * Read and parse domains.yml manifest from memory root with caching.
 * - Cache entries expire after 5 seconds (TTL)
 * - File watching automatically invalidates cache on changes
 * - Returns an empty domains array on error (file not found, parse error, etc).
 */
export async function readDomainsManifest(memoryRoot: string): Promise<DomainsManifest> {
  // Check cache first
  const cached = cache.get(memoryRoot);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.manifest;
  }

  // Set up file watcher for this memoryRoot (idempotent)
  setupFileWatcher(memoryRoot);

  // Read from disk
  const filePath = path.join(memoryRoot, "domains.yml");
  const manifest = await loadYamlFile<DomainsManifest>(filePath, { domains: [] });
  
  // Update cache
  cache.set(memoryRoot, {
    manifest,
    timestamp: Date.now(),
  });
  
  return manifest;
}
