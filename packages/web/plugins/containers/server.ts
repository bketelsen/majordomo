/**
 * Containers widget plugin - server-side logic
 * 
 * This plugin monitors Docker and Incus containers and provides control actions.
 */

import type { WidgetPlugin, WidgetContext } from "../../src/types.ts";
import {
  listAllContainers,
  dockerAction,
  incusAction,
  type ContainerInfo,
} from "./lib.ts";

export const plugin: WidgetPlugin = {
  async register(app, ctx) {
    // Register custom action endpoint for container control
    app.post(`/api/widgets/${ctx.id}/action/:runtime/:id/:action`, async (c) => {
      const { runtime, id, action } = c.req.param();
      
      if (!["start", "stop", "restart"].includes(action)) {
        return c.json({ error: "Invalid action" }, 400);
      }
      
      const act = action as "start" | "stop" | "restart";
      let ok = false;
      
      if (runtime === "docker") {
        ok = await dockerAction(id, act);
      } else if (runtime === "incus") {
        ok = await incusAction(id, act);
      } else {
        return c.json({ error: "Unknown runtime" }, 400);
      }
      
      return c.json({ ok });
    });
  },

  async getData(ctx) {
    const containers = await listAllContainers();
    
    return {
      containers,
      updatedAt: Date.now(),
      meta: {
        total: containers.length,
        running: containers.filter(c => c.running).length,
      },
    };
  },
};
