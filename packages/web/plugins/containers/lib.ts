/**
 * Container management logic for Docker and Incus
 * 
 * Self-contained implementation that queries Docker and Incus via their Unix sockets.
 * Owned by the Containers plugin; no dependencies on shared widget code.
 */

import { request as httpRequest } from "node:http";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  ports: string[];
  runtime: "docker" | "incus";
}

// ── Unix socket HTTP helper ────────────────────────────────────────────────────

async function unixRequest(
  socketPath: string,
  path: string,
  method = "GET",
  body?: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Docker ────────────────────────────────────────────────────────────────────

const DOCKER_SOCK = "/var/run/docker.sock";

export async function listDockerContainers(): Promise<ContainerInfo[]> {
  try {
    const data = await unixRequest(DOCKER_SOCK, "/containers/json?all=1") as Array<Record<string, unknown>>;
    return data.map((c) => {
      const names = (c.Names as string[]) ?? [];
      const ports = ((c.Ports as Array<{ PublicPort?: number; PrivatePort: number; Type: string }>) ?? [])
        .filter((p) => p.PublicPort)
        .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`);
      return {
        id: (c.Id as string).slice(0, 12),
        name: names[0]?.replace(/^\//, "") ?? "unknown",
        image: c.Image as string,
        status: c.Status as string,
        running: c.State === "running",
        ports,
        runtime: "docker",
      };
    });
  } catch {
    return [];
  }
}

export async function dockerAction(id: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  try {
    await unixRequest(DOCKER_SOCK, `/containers/${id}/${action}`, "POST");
    return true;
  } catch {
    return false;
  }
}

// ── Incus ─────────────────────────────────────────────────────────────────────

const INCUS_SOCK = "/var/lib/incus/unix.socket";

export async function listIncusContainers(): Promise<ContainerInfo[]> {
  try {
    const data = await unixRequest(INCUS_SOCK, "/1.0/instances?recursion=1") as {
      metadata: Array<{ name: string; status: string; type: string; description: string }>;
    };
    return (data.metadata ?? []).map((inst) => ({
      id: inst.name,
      name: inst.name,
      image: inst.description || inst.type,
      status: inst.status,
      running: inst.status.toLowerCase() === "running",
      ports: [],
      runtime: "incus",
    }));
  } catch {
    return [];
  }
}

export async function incusAction(name: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  try {
    // Incus uses "stop" → "stop", "start" → "start", "restart" → "restart"
    await unixRequest(
      INCUS_SOCK,
      `/1.0/instances/${name}/state`,
      "PUT",
      JSON.stringify({ action, timeout: 30 })
    );
    return true;
  } catch {
    return false;
  }
}

// ── Combined ──────────────────────────────────────────────────────────────────

export async function listAllContainers(): Promise<ContainerInfo[]> {
  const [docker, incus] = await Promise.all([
    listDockerContainers(),
    listIncusContainers(),
  ]);
  // Sort: running first, then by name
  return [...docker, ...incus].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
