/**
 * Filesystem helper utilities
 */

import * as fs from "node:fs/promises";

/**
 * Check if a file or directory exists.
 * @param path - Path to check
 * @returns Promise that resolves to true if the path exists, false otherwise
 */
export async function fileExists(path: string): Promise<boolean> {
  return fs.access(path).then(() => true).catch(() => false);
}
