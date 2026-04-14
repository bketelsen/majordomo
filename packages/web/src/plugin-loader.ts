/**
 * Plugin discovery and loading system for Majordomo widgets
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Hono } from "hono";
import type { EventEmitter } from "node:events";
import { Database } from "bun:sqlite";
import type {
  PluginManifest,
  LoadedPlugin,
  WidgetPlugin,
  WidgetContext,
  PluginPermissions,
} from "./types.ts";

export type { LoadedPlugin };

// ── Permission validation ─────────────────────────────────────────────────────

function validatePermissions(perms: PluginPermissions): boolean {
  // For first-party plugins, we trust the permissions
  // Future: Add stricter validation and user approval prompts
  
  // Restrict socket access to known paths
  if (perms.socket) {
    const allowedSockets = [
      "/var/run/docker.sock",
      "/var/lib/incus/unix.socket",
    ];
    const allValid = perms.socket.every(s => allowedSockets.includes(s));
    if (!allValid) {
      console.warn(`[plugins] Invalid socket permissions: ${perms.socket.join(', ')}`);
      return false;
    }
  }
  
  // Warn about dangerous permissions
  if (perms.exec?.allowed || perms.network) {
    console.warn(`[plugins] Plugin requests elevated permissions (exec/network)`);
    // For now, allow - but in future, prompt user
  }
  
  return true;
}

// ── Plugin loader ─────────────────────────────────────────────────────────────

export async function loadPlugins(pluginDir: string): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  try {
    const entries = await fs.readdir(pluginDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      // Skip example directories
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      const pluginPath = path.join(pluginDir, entry.name);
      const manifestPath = path.join(pluginPath, "plugin.json");

      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest: PluginManifest = JSON.parse(manifestContent);

        // Validate permissions
        if (!validatePermissions(manifest.permissions)) {
          console.warn(`[plugins] Skipping ${manifest.id}: invalid permissions`);
          continue;
        }

        // Load server module
        const serverPath = path.join(pluginPath, manifest.server);
        const serverModule = await import(serverPath);

        // Validate server interface
        if (!serverModule.plugin || typeof serverModule.plugin.getData !== "function") {
          console.warn(`[plugins] Skipping ${manifest.id}: invalid server module (missing getData)`);
          continue;
        }

        plugins.push({
          manifest,
          server: serverModule.plugin as WidgetPlugin,
          clientPath: path.join(pluginPath, manifest.client),
        });

        console.log(`[plugins] ✓ Loaded: ${manifest.name} (${manifest.id}@${manifest.version})`);
      } catch (err) {
        console.error(`[plugins] Failed to load ${entry.name}:`, err);
      }
    }
  } catch (err) {
    // Plugin directory doesn't exist yet - that's OK
    console.log(`[plugins] Plugin directory not found: ${pluginDir} (will use legacy widgets)`);
  }

  return plugins;
}

// ── Plugin registration ───────────────────────────────────────────────────────

export interface GlobalContext {
  dataRoot: string;
  webEvents: EventEmitter;
}

export function registerPlugins(
  app: Hono,
  plugins: LoadedPlugin[],
  ctx: GlobalContext
): void {
  for (const plugin of plugins) {
    const widgetCtx: WidgetContext = {
      id: plugin.manifest.id,
      config: plugin.manifest.config,
      dataDir: path.join(ctx.dataRoot, "widgets", plugin.manifest.id),
      
      broadcast: (event, data) => {
        ctx.webEvents.emit(event, data);
      },
      
      subscribe: (event, handler) => {
        ctx.webEvents.on(event, handler);
      },
      
      db: {
        open: async (name) => {
          await fs.mkdir(widgetCtx.dataDir, { recursive: true });
          const dbPath = path.join(widgetCtx.dataDir, `${name}.db`);
          return new Database(dbPath);
        },
      },
    };

    // Call plugin's register hook if defined
    if (plugin.server.register) {
      try {
        plugin.server.register(app, widgetCtx);
        console.log(`[plugins] Registered routes for: ${plugin.manifest.id}`);
      } catch (err) {
        console.error(`[plugins] Failed to register ${plugin.manifest.id}:`, err);
      }
    } else {
      // Auto-register default GET handler
      app.get(`/api/widgets/${plugin.manifest.id}`, async (c) => {
        try {
          const data = await plugin.server.getData(widgetCtx);
          return c.json({ widget: plugin.manifest.id, data });
        } catch (err) {
          console.error(`[plugins] Error fetching ${plugin.manifest.id}:`, err);
          return c.json({ error: "Failed to fetch widget data" }, 500);
        }
      });
    }

    // Start background polling if defined
    if (plugin.server.startPolling) {
      try {
        plugin.server.startPolling(widgetCtx);
        console.log(`[plugins] Started polling for: ${plugin.manifest.id}`);
      } catch (err) {
        console.error(`[plugins] Failed to start polling for ${plugin.manifest.id}:`, err);
      }
    }
  }

  // Serve plugin client modules as static files
  app.get("/plugins/:id/client.js", async (c) => {
    const id = c.req.param("id");
    const plugin = plugins.find(p => p.manifest.id === id);
    
    if (!plugin) {
      return c.notFound();
    }

    try {
      const content = await fs.readFile(plugin.clientPath, "utf-8");
      return new Response(content, {
        headers: { 
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache", // Dev mode - always reload
        },
      });
    } catch (err) {
      console.error(`[plugins] Failed to serve client for ${id}:`, err);
      return c.text("Failed to load plugin client", 500);
    }
  });

  // Plugin registry endpoint (for frontend discovery)
  app.get("/api/plugins", (c) => {
    const registry = plugins.map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      icon: p.manifest.icon,
      config: p.manifest.config,
      version: p.manifest.version,
    }));
    return c.json({ plugins: registry });
  });

  console.log(`[plugins] Registered ${plugins.length} plugin(s)`);
}
