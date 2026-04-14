/**
 * Container widget helpers — LEGACY COMPATIBILITY LAYER
 * 
 * This module now re-exports from the Containers plugin to maintain backward compatibility
 * with legacy widget fallback code in server.ts.
 * 
 * The Containers plugin (packages/web/plugins/containers/) is the source of truth.
 * 
 * TODO: Once all widgets are migrated to plugins, remove this file and update server.ts
 * to remove legacy fallback endpoints.
 */

export type {
  ContainerInfo,
} from "../../plugins/containers/lib.ts";

export {
  listAllContainers,
  listDockerContainers,
  listIncusContainers,
  dockerAction,
  incusAction,
} from "../../plugins/containers/lib.ts";
