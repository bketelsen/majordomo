# Majordomo Plugin Quick Reference

## Plugin File Structure

```
plugins/{plugin-id}/
├── plugin.json          # Required: manifest
├── server.ts            # Required: server-side logic
└── client.ts            # Required: client-side renderer
```

## Minimal Plugin Example

### plugin.json
```json
{
  "id": "my-widget",
  "version": "1.0.0",
  "name": "My Widget",
  "description": "Widget description",
  "icon": "📊",
  "permissions": {},
  "server": "./server.ts",
  "client": "./client.ts",
  "config": {}
}
```

### server.ts
```typescript
import type { WidgetPlugin } from "../../src/types.ts";

export const plugin: WidgetPlugin = {
  async getData(ctx) {
    return {
      message: "Hello!",
      updatedAt: Date.now(),
    };
  },
};
```

### client.ts
```typescript
import type { WidgetRenderer } from "../../src/types.ts";

const escape = (s: string) => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

export const renderer: WidgetRenderer = {
  render(data: unknown) {
    const { message } = data as { message: string };
    return `<div>${escape(message)}</div>`;
  },
};
```

## Common Patterns

### Custom Action Endpoint
```typescript
// server.ts
async register(app, ctx) {
  app.post(`/api/widgets/${ctx.id}/action`, async (c) => {
    const { action } = await c.req.json();
    // Handle action
    return c.json({ ok: true });
  });
}
```

### Interactive Client
```typescript
// client.ts
mount(element, data) {
  element.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await fetch('/api/widgets/my-widget/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'do-something' }),
      });
      // Refresh widget
      window.loadWidget?.('my-widget');
    });
  });
}
```

### Database Storage
```typescript
// server.ts
async getData(ctx) {
  const db = await ctx.db.open('mydata');
  const rows = db.query('SELECT * FROM items').all();
  db.close();
  return { items: rows, updatedAt: Date.now() };
}
```

### Background Polling
```typescript
// server.ts
async startPolling(ctx) {
  setInterval(async () => {
    const data = await this.getData(ctx);
    ctx.broadcast('widget:update', { widget: ctx.id, data });
  }, ctx.config.refreshInterval);
}
```

## Type Imports

```typescript
import type { 
  WidgetPlugin,
  WidgetContext,
  WidgetData,
  WidgetRenderer,
  PluginManifest,
  PluginPermissions,
} from "../../src/types.ts";
```

## Server Context API

```typescript
ctx.id              // Plugin ID
ctx.config          // From plugin.json config
ctx.dataDir         // ~/.majordomo/data/widgets/{id}/
ctx.broadcast(event, data)
ctx.subscribe(event, handler)
ctx.db.open(name)   // SQLite database
```

## Client Renderer API

```typescript
renderer.render(data, config)       // → HTML string (required)
renderer.mount(element, data, config)   // Initialize (optional)
renderer.unmount(element)               // Cleanup (optional)
renderer.styles                         // CSS string (optional)
```

## Permissions

```json
{
  "permissions": {
    "socket": ["/var/run/docker.sock"],
    "env": ["VAR_NAME"],
    "network": false,
    "filesystem": {
      "read": ["/path"],
      "write": ["/path"]
    },
    "exec": { "allowed": false },
    "database": { "own": true }
  }
}
```

## Testing

```bash
# Build check
cd packages/web
bun build --target=node plugins/my-widget/server.ts
bun build --target=node plugins/my-widget/client.ts

# Start server (check logs for plugin loading)
bun src/server.ts
# Should see: [plugins] ✓ Loaded: My Widget (my-widget@1.0.0)

# Test endpoints
curl http://localhost:3000/api/plugins
curl http://localhost:3000/api/widgets/my-widget
curl http://localhost:3000/plugins/my-widget/client.js
```

## Debugging

### Plugin not loading?
- Check `plugin.json` is valid JSON
- Verify `server` and `client` paths
- Look for `[plugins]` logs on server startup

### Client not rendering?
- Check browser console for errors
- Verify client module exports `renderer`
- Test with minimal `render()` implementation

### Action not working?
- Check route registration in `register()`
- Verify endpoint matches fetch URL
- Check browser network tab for 404s

## Frontend Integration

Widgets auto-render if plugin exists, otherwise fallback to legacy:

```javascript
// In index.html
async function loadWidget(name) {
  const res = await fetch(`/api/widgets/${name}`);
  const data = await res.json();
  
  const plugin = pluginRegistry.get(name);
  if (plugin?.renderer) {
    // Use plugin
    renderPluginWidget(name, plugin, data.data);
  } else {
    // Use legacy
    renderLegacyWidget(name, data.data);
  }
}
```

## Migration Checklist

Migrating a legacy widget to plugin:

- [ ] Create `plugins/{name}/` directory
- [ ] Write `plugin.json` manifest
- [ ] Move server logic to `server.ts`
- [ ] Extract client rendering to `client.ts`
- [ ] Test with `bun src/server.ts`
- [ ] Verify in browser
- [ ] (Optional) Remove legacy code
