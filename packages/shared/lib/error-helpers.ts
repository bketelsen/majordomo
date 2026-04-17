/**
 * Error handling helper utilities
 */

/**
 * Format an error into a string message.
 * Extracts the message from Error instances, or converts other values to strings.
 * @param err - The error value to format
 * @returns The formatted error message string
 */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
