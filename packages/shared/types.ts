/**
 * Shared global type declarations for sionapi
 */

import type { DomainContextManager } from "../agent/lib/domain-context-manager.ts";

declare global {
  var __majordomoManager: DomainContextManager | undefined;
}

export {};
