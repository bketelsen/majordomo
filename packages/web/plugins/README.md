# Majordomo Widget Plugins

This directory contains widget plugins for the Majordomo dashboard.

## What is a Widget Plugin?

A widget plugin packages both server-side data logic and client-side UI rendering into a single cohesive unit. Each plugin is self-contained in its own directory with a manifest, server module, and client module.

## Plugin Structure

```
plugins/
└── containers/              # Example plugin
    ├── plugin.json          # Manifest with metadata and permissions
    ├── server.ts            # Server-side data provider and API routes
    └── client.ts            # Client-side rendering logic
```

## Creating a Plugin

### 1. Create Plugin Directory

```bash
mkdir -p plugins/my-widget
```

### 2. Create Manifest (`plugin.json`)

```json
{
  "id": "my-widget",
  "version": "1.0.0",
  "name": "My Widget",
  "description": "A custom widget for Majordomo",
  "icon": "📊",
  
  "permissions": {
    "socket": [],
    "network": false,
    "filesystem": { "read": [], "write": [] }
  },
  
  "server": "./server.ts",
  "client": "./client.ts",
  
  "config": {
    "refreshInterval": 30000
  }
}
```

### 3. Implement Server Module (`server.ts`)

```typescript
import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";

export const plugin: WidgetPlugin = {
  // Optional: register custom routes
  async register(app, ctx) {
    app.post(`/api/widgets/${ctx.id}/action`, async (c) => {
      // Handle custom actions
      return c.json({ ok: true });
    });
  },

  // Required: fetch widget data
  async getData(ctx) {
    return {
      message: "Hello from my widget!",
      updatedAt: Date.now(),
    };
  },
};
```

### 4. Implement Client Module (`client.ts`)

```typescript
import type { WidgetRenderer } from "../../src/types.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const renderer: WidgetRenderer = {
  render(data: unknown) {
    const { message } = data as { message: string };
    return `<div>${escapeHtml(message)}</div>`;
  },

  // Optional: initialize after DOM insertion
  mount(element, data, config) {
    // Attach event listeners, etc.
  },

  // Optional: cleanup before re-render
  unmount(element) {
    // Remove listeners, clear timers
  },

  // Optional: custom CSS
  styles: `
    .my-custom-class {
      color: var(--accent);
    }
  `,
};
```

### 5. Restart Server

The plugin will be automatically discovered and loaded on server startup.

```bash
bun run packages/web/src/server.ts
```

## Plugin API

### Server-Side Context

The `WidgetContext` provides:

- `id` - Plugin identifier
- `config` - Configuration from manifest
- `dataDir` - Plugin-specific data directory (`~/.majordomo/data/widgets/{id}/`)
- `broadcast(event, data)` - Emit events to connected clients
- `subscribe(event, handler)` - Listen to system events
- `db.open(name)` - Open a SQLite database in the plugin's data directory

### Client-Side Renderer

The `WidgetRenderer` interface:

- `render(data, config)` - Return HTML string (required)
- `mount(element, data, config)` - Initialize after render (optional)
- `unmount(element)` - Cleanup before re-render (optional)
- `styles` - CSS to inject (optional)

## Permissions

Plugins declare required capabilities in their manifest:

```json
{
  "permissions": {
    "socket": ["/var/run/docker.sock"],       // Unix socket access
    "env": ["DOCKER_HOST"],                   // Environment variables
    "network": false,                          // Network access
    "filesystem": {
      "read": ["/path/to/read"],
      "write": ["/path/to/write"]
    },
    "exec": {
      "allowed": false,                        // Process execution
      "commands": []
    },
    "database": {
      "own": true,                             // Own SQLite DB
      "shared": false                          // Access shared DBs
    }
  }
}
```

## Examples

See the `containers/` plugin for a complete working example that:
- Queries Docker and Incus via Unix sockets
- Provides container control actions (start/stop/restart)
- Renders a dynamic list with interactive buttons
- Handles errors gracefully

## Migration from Legacy Widgets

The plugin system coexists with legacy inline widgets. To migrate:

1. Create a plugin directory with the three required files
2. Move server logic from `src/lib/{name}.ts` to `plugins/{name}/server.ts`
3. Extract client rendering from `static/index.html` to `plugins/{name}/client.ts`
4. The system will automatically prefer the plugin over legacy code

Legacy widgets continue to work as fallback if no plugin is found.

## Best Practices

1. **Always escape user input** in client rendering to prevent XSS
2. **Keep data fetching fast** - widgets load on every page view
3. **Handle errors gracefully** - don't crash if external services are unavailable
4. **Use TypeScript** for type safety and better DX
5. **Test mount/unmount** if you attach event listeners
6. **Keep plugins focused** - one responsibility per widget

## Troubleshooting

### Plugin not loading

Check server logs for:
```
[plugins] ✓ Loaded: Your Plugin Name (your-id@1.0.0)
```

If missing, verify:
- `plugin.json` is valid JSON
- `server` and `client` paths are correct
- Server module exports `plugin` object
- Client module exports `renderer` object

### Client module not found

The client is served at `/plugins/{id}/client.js`. Check:
- Browser console for 404 errors
- Client file exists and is valid TypeScript/JavaScript
- No syntax errors in client module

### Widget shows "Plugin render error"

Check browser console for the error. Common issues:
- Accessing undefined properties in `data`
- Missing `escapeHtml` calls
- Syntax errors in template strings

## Security Notes

This is a **first-party plugin system** for personal/internal use. There is:
- No sandboxing - plugins run with full Node.js/browser access
- No signature verification - plugins are trusted by default
- No marketplace - install only plugins you author or trust

Future enhancements may add Worker-based isolation or WASM sandboxing.
