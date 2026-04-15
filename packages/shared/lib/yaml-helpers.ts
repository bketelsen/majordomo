import { promises as fs } from "fs";
import yaml from "js-yaml";

/**
 * Load and parse a YAML file with a default fallback.
 * Encapsulates the read-parse-fallback pattern used throughout the codebase.
 * 
 * @param path - Path to the YAML file
 * @param defaultValue - Default value to return if file doesn't exist or parsing fails
 * @returns Parsed YAML content or default value
 */
export async function loadYamlFile<T>(path: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(path, "utf-8");
    return (yaml.load(content) as T) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
