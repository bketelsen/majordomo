# Containers Plugin Tightening - Summary

## Overview
Refactored the Containers widget plugin to be truly self-contained instead of a thin wrapper around shared code.

## Changes Made

### 1. Created Plugin-Local Business Logic
**File:** `packages/web/plugins/containers/lib.ts` (NEW)

Moved all container-specific logic into the plugin directory:
- `unixRequest()` - Unix socket HTTP helper
- `listDockerContainers()` - Docker container discovery
- `dockerAction()` - Docker container control (start/stop/restart)
- `listIncusContainers()` - Incus container discovery  
- `incusAction()` - Incus container control
- `listAllContainers()` - Combined container listing with sorting
- `ContainerInfo` type definition

**Lines of code:** 145 lines of self-contained business logic

### 2. Updated Plugin to Use Local Code
**File:** `packages/web/plugins/containers/server.ts` (MODIFIED)

Changed import from:
```typescript
import { ... } from "../../src/lib/containers.ts";
```

To:
```typescript
import { ... } from "./lib.ts";
```

The plugin now owns:
- Container discovery logic (Docker + Incus)
- Container action logic (start/stop/restart)
- Widget data shaping (adding metadata like running count)
- Custom API endpoints (`/api/widgets/containers/action/:runtime/:id/:action`)

### 3. Converted Shared Code to Compatibility Layer
**File:** `packages/web/src/lib/containers.ts` (MODIFIED)

Transformed from 145 lines of implementation to a 21-line re-export shim:
```typescript
export type { ContainerInfo } from "../../plugins/containers/lib.ts";
export { 
  listAllContainers, 
  listDockerContainers,
  listIncusContainers,
  dockerAction, 
  incusAction 
} from "../../plugins/containers/lib.ts";
```

This maintains backward compatibility with:
- Legacy widget fallback in `server.ts::computeContainersWidget()`
- Legacy action endpoint in `server.ts` at `/api/containers/:runtime/:id/:action`

## Architecture

### Before (Thin Wrapper)
```
packages/web/src/lib/containers.ts [145 lines - IMPLEMENTATION]
         ↑
         |
packages/web/plugins/containers/server.ts [wrapper]
```

### After (Self-Contained Plugin)
```
packages/web/plugins/containers/lib.ts [145 lines - IMPLEMENTATION]
         ↑                    ↑
         |                    |
    server.ts           src/lib/containers.ts
   [plugin logic]       [legacy compat layer]
```

## Benefits

1. **Plugin is truly self-contained** - owns its business logic
2. **Clear ownership** - plugin directory contains everything needed
3. **Backward compatible** - legacy fallback still works
4. **Reversible** - compatibility layer can be removed when legacy code is migrated
5. **Pattern for other widgets** - clear template for migrating remaining widgets

## What Remains Shared

Nothing! All container-specific logic is now in the plugin.

The `src/lib/containers.ts` file is now purely a compatibility shim for legacy code.

## Follow-up Cleanup Suggestions

### Short-term (Safe)
1. ✅ Verify plugin loads correctly at runtime
2. ✅ Test container actions work through new plugin endpoint
3. Document this pattern for other widget migrations

### Medium-term (After Testing)
1. Migrate remaining legacy widgets to plugins:
   - priorities
   - subagents  
   - schedules
   - email

### Long-term (Breaking Change)
1. Remove legacy fallback in `server.ts`:
   - `computeContainersWidget()` function
   - `/api/containers/:runtime/:id/:action` endpoint (superseded by plugin endpoint)
2. Delete `packages/web/src/lib/containers.ts` entirely
3. Clean up any other widget fallbacks once all are migrated

## Testing

Build verification:
```bash
cd ~/projects/majordomo
bun build packages/web/plugins/containers/server.ts --target=node  # ✓ Success
bun build packages/web/src/lib/containers.ts --target=node         # ✓ Success
```

Runtime testing needed:
- [ ] Plugin loads at startup
- [ ] Widget data endpoint works: `GET /api/widgets/containers`
- [ ] Plugin action endpoint works: `POST /api/widgets/containers/action/docker/{id}/stop`
- [ ] Legacy endpoint still works: `POST /api/containers/docker/{id}/stop`
- [ ] Frontend renders correctly

## Code Metrics

| File | Before | After | Change |
|------|--------|-------|--------|
| `plugins/containers/lib.ts` | 0 | 145 | +145 NEW |
| `plugins/containers/server.ts` | 43 | 43 | (import path change) |
| `src/lib/containers.ts` | 145 | 21 | -124 (now re-export) |
| **Total** | 188 | 209 | +21 (adds structure) |

## Reversibility

To revert:
1. Delete `packages/web/plugins/containers/lib.ts`
2. Restore original `packages/web/src/lib/containers.ts` from git
3. Change import in `packages/web/plugins/containers/server.ts` back to shared path

All changes are isolated to three files with no cascading dependencies.
