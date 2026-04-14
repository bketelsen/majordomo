/**
 * Type definitions for the Majordomo plugin system
 */

import type { Hono } from "hono";
import type { Database } from "bun:sqlite";

// ── Server-side ───────────────────────────────────────────────────────────────

export interface WidgetPlugin {
  /** Called once at startup to register routes and initialize */
  register?(app: Hono, ctx: WidgetContext): Promise<void> | void;

  /** Fetch widget data (called by default GET /api/widgets/:id handler) */
  getData(ctx: WidgetContext): Promise<WidgetData>;

  /** Optional: start background polling or timers */
  startPolling?(ctx: WidgetContext): Promise<void> | void;

  /** Optional: cleanup on shutdown */
  cleanup?(ctx: WidgetContext): Promise<void> | void;
}

export interface WidgetContext {
  id: string;
  config: Record<string, unknown>;
  dataDir: string;

  broadcast(event: string, data: unknown): void;
  subscribe(event: string, handler: (data: unknown) => void): void;

  db: {
    open(name: string): Promise<Database>;
  };
}

export interface WidgetData {
  [key: string]: unknown;
  updatedAt: number;
  meta?: Record<string, unknown>;
}

// ── Client-side ───────────────────────────────────────────────────────────────

export interface WidgetRenderer {
  /** Render widget HTML from data */
  render(data: unknown, config: Record<string, unknown>): string;

  /** Optional: initialize after DOM insertion */
  mount?(element: HTMLElement, data: unknown, config: Record<string, unknown>): void;

  /** Optional: cleanup before re-render */
  unmount?(element: HTMLElement): void;

  /** Optional: CSS to inject into page */
  styles?: string;
}

// ── Plugin manifest ───────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  icon: string;

  author?: {
    name: string;
    email?: string;
    url?: string;
  };

  permissions: PluginPermissions;
  server: string;
  client: string;
  config: Record<string, unknown>;

  dependencies?: {
    node?: string;
    bun?: string;
  };
}

export interface PluginPermissions {
  socket?: string[];
  env?: string[];
  network?: boolean | { hosts: string[] };
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  exec?: {
    allowed: boolean;
    commands?: string[];
  };
  database?: {
    shared?: boolean;
    own?: boolean;
  };
}

// ── Loaded plugin ─────────────────────────────────────────────────────────────

export interface LoadedPlugin {
  manifest: PluginManifest;
  server: WidgetPlugin;
  clientPath: string;
}
