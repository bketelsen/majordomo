import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DomainContextManager } from "../lib/domain-context-manager.ts";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

describe("DomainContextManager", () => {
  let tempDir: string;
  let manager: DomainContextManager;

  beforeEach(async () => {
    // Create temp directory for test
    tempDir = await mkdtemp(path.join(tmpdir(), "majordomo-test-"));

    const memoryRoot = path.join(tempDir, "memory");
    const dataRoot = path.join(tempDir, "data");
    const projectRoot = tempDir;
    const personaFile = path.join(tempDir, "persona.md");
    const agentsDir = path.join(tempDir, "agents");
    const workflowsDir = path.join(tempDir, "workflows");

    // Create directories
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.mkdir(workflowsDir, { recursive: true });

    // Create minimal domains.yml
    const domainsManifest = {
      domains: [
        { id: "general", status: "active" },
        { id: "personal", status: "active" },
        { id: "work", status: "active" },
        { id: "archived-domain", status: "archived" },
      ],
    };
    await fs.writeFile(
      path.join(memoryRoot, "domains.yml"),
      yaml.dump(domainsManifest),
      "utf-8"
    );

    // Create minimal persona file
    await fs.writeFile(
      personaFile,
      "You are Majordomo.\nActive domain: {{ACTIVE_DOMAIN}}",
      "utf-8"
    );

    manager = new DomainContextManager({
      projectRoot,
      memoryRoot,
      dataRoot,
      personaFile,
      agentsDir,
      workflowsDir,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    if (manager) {
      try {
        manager.dispose();
      } catch (err) {
        console.debug('[test] Session may not have been initialized:', err);
        // Session may not have been initialized if initialize() threw
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("initialize() reads domains.yml and sets activeDomain to 'general'", async () => {
    await manager.initialize();
    expect(manager.getDomain()).toBe("general");
  });

  it("switchDomain() changes activeDomain", async () => {
    await manager.initialize();
    expect(manager.getDomain()).toBe("general");

    await manager.switchDomain("personal");
    expect(manager.getDomain()).toBe("personal");

    await manager.switchDomain("work");
    expect(manager.getDomain()).toBe("work");
  });

  it("switchDomain() throws on unknown domain", async () => {
    await manager.initialize();

    expect(async () => {
      await manager.switchDomain("nonexistent");
    }).toThrow();
  });

  it("switchDomain() throws on archived domain", async () => {
    await manager.initialize();

    expect(async () => {
      await manager.switchDomain("archived-domain");
    }).toThrow();
  });

  it("domains() returns active domain IDs", async () => {
    await manager.initialize();

    const domains = await manager.domains();
    expect(domains).toEqual(["general", "personal", "work"]);
    expect(domains).not.toContain("archived-domain");
  });

  it("initialize() throws if no domains configured", async () => {
    // Overwrite domains.yml with empty manifest
    const memoryRoot = path.join(tempDir, "memory");
    await fs.writeFile(
      path.join(memoryRoot, "domains.yml"),
      yaml.dump({ domains: [] }),
      "utf-8"
    );

    expect(async () => {
      await manager.initialize();
    }).toThrow();
  });
});
