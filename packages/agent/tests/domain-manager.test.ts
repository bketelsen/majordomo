import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

interface CogDomain {
  id: string;
  path: string;
  type: string;
  label: string;
  triggers: string[];
  files: string[];
  status?: "active" | "archived";
  created_at?: string;
  workingDir?: string;
}

interface DomainsManifest {
  domains: CogDomain[];
}

async function readDomainsManifest(memoryRoot: string): Promise<DomainsManifest> {
  const filePath = path.join(memoryRoot, "domains.yml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return (yaml.load(content) as DomainsManifest) ?? { domains: [] };
  } catch {
    return { domains: [] };
  }
}

async function writeDomainsManifest(memoryRoot: string, manifest: DomainsManifest): Promise<void> {
  const filePath = path.join(memoryRoot, "domains.yml");
  const header =
    "# Majordomo Domain Manifest — managed by domain-manager extension\n# To add domains: ask Majordomo to create one\n\n";
  await fs.writeFile(filePath, header + yaml.dump(manifest, { lineWidth: 120 }), "utf-8");
}

async function scaffoldDomainFiles(memoryRoot: string, domainPath: string, files: string[]): Promise<void> {
  const domainDir = path.join(memoryRoot, domainPath);
  await fs.mkdir(domainDir, { recursive: true });

  const l0Map: Record<string, string> = {
    "hot-memory": `${domainPath} hot memory — current state summary`,
    observations: `${domainPath} observations — append-only timestamped events`,
    "action-items": `${domainPath} tasks — open and completed action items`,
    entities: `${domainPath} entities — people, orgs, and named things registry`,
    health: `${domainPath} health — current state and medical history`,
    calendar: `${domainPath} calendar — scheduled events and appointments`,
    "dev-log": `${domainPath} dev log — development notes and decisions`,
    habits: `${domainPath} habits — current tracking and patterns`,
    projects: `${domainPath} projects — active and completed project list`,
  };

  for (const file of files) {
    const filePath = path.join(domainDir, `${file}.md`);
    const exists = await fs.access(filePath).then(() => true, () => false);
    if (exists) continue;

    const l0 = l0Map[file] ?? `${domainPath} ${file}`;
    const title = file
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    const content = `<!-- L0: ${l0} -->\n# ${title}\n`;
    await fs.writeFile(filePath, content, "utf-8");
  }
}

describe("Domain Manager", () => {
  let tempDir: string;
  let memoryRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "domain-mgr-test-"));
    memoryRoot = path.join(tempDir, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readDomainsManifest()", () => {
    it("parses domains.yml correctly", async () => {
      const manifest: DomainsManifest = {
        domains: [
          {
            id: "general",
            path: "general",
            type: "general",
            label: "General domain",
            triggers: ["general", "misc"],
            files: ["hot-memory", "observations"],
            status: "active",
          },
          {
            id: "work",
            path: "work",
            type: "work",
            label: "Work domain",
            triggers: ["work", "job"],
            files: ["hot-memory", "dev-log"],
            status: "active",
          },
        ],
      };

      await fs.writeFile(path.join(memoryRoot, "domains.yml"), yaml.dump(manifest), "utf-8");

      const result = await readDomainsManifest(memoryRoot);

      expect(result.domains.length).toBe(2);
      expect(result.domains[0].id).toBe("general");
      expect(result.domains[1].id).toBe("work");
      expect(result.domains[0].triggers).toEqual(["general", "misc"]);
    });

    it("returns empty domains array if file does not exist", async () => {
      const result = await readDomainsManifest(memoryRoot);
      expect(result.domains).toEqual([]);
    });

    it("handles nested domain paths", async () => {
      const manifest: DomainsManifest = {
        domains: [
          {
            id: "work/acme",
            path: "work/acme",
            type: "work",
            label: "Acme Corp project",
            triggers: ["acme"],
            files: ["hot-memory"],
          },
        ],
      };

      await fs.writeFile(path.join(memoryRoot, "domains.yml"), yaml.dump(manifest), "utf-8");

      const result = await readDomainsManifest(memoryRoot);
      expect(result.domains[0].id).toBe("work/acme");
      expect(result.domains[0].path).toBe("work/acme");
    });
  });

  describe("writeDomainsManifest()", () => {
    it("writes valid YAML", async () => {
      const manifest: DomainsManifest = {
        domains: [
          {
            id: "personal",
            path: "personal",
            type: "personal",
            label: "Personal life",
            triggers: ["personal", "life"],
            files: ["hot-memory", "health"],
            status: "active",
            created_at: "2024-01-01",
          },
        ],
      };

      await writeDomainsManifest(memoryRoot, manifest);

      const content = await fs.readFile(path.join(memoryRoot, "domains.yml"), "utf-8");

      // Verify it's valid YAML
      const parsed = yaml.load(content) as DomainsManifest;
      expect(parsed.domains.length).toBe(1);
      expect(parsed.domains[0].id).toBe("personal");
      expect(parsed.domains[0].files).toEqual(["hot-memory", "health"]);

      // Verify header comment exists
      expect(content).toContain("# Majordomo Domain Manifest");
    });

    it("preserves domain structure on round-trip", async () => {
      const original: DomainsManifest = {
        domains: [
          {
            id: "project-alpha",
            path: "project-alpha",
            type: "project",
            label: "Project Alpha",
            triggers: ["alpha", "project-a"],
            files: ["hot-memory", "dev-log", "action-items"],
            workingDir: "/home/user/projects/alpha",
          },
        ],
      };

      await writeDomainsManifest(memoryRoot, original);
      const result = await readDomainsManifest(memoryRoot);

      expect(result.domains[0]).toEqual(original.domains[0]);
    });
  });

  describe("scaffoldDomainFiles()", () => {
    it("creates expected files with L0 headers", async () => {
      const files = ["hot-memory", "observations", "action-items"];
      await scaffoldDomainFiles(memoryRoot, "test-domain", files);

      // Verify directory exists
      const domainDir = path.join(memoryRoot, "test-domain");
      const dirExists = await fs.access(domainDir).then(() => true, () => false);
      expect(dirExists).toBe(true);

      // Verify hot-memory.md
      const hotMemory = await fs.readFile(path.join(domainDir, "hot-memory.md"), "utf-8");
      expect(hotMemory).toContain("<!-- L0: test-domain hot memory — current state summary -->");
      expect(hotMemory).toContain("# Hot Memory");

      // Verify observations.md
      const observations = await fs.readFile(path.join(domainDir, "observations.md"), "utf-8");
      expect(observations).toContain("<!-- L0: test-domain observations — append-only timestamped events -->");
      expect(observations).toContain("# Observations");

      // Verify action-items.md
      const actionItems = await fs.readFile(path.join(domainDir, "action-items.md"), "utf-8");
      expect(actionItems).toContain("<!-- L0: test-domain tasks — open and completed action items -->");
      expect(actionItems).toContain("# Action Items");
    });

    it("creates nested domain directories", async () => {
      await scaffoldDomainFiles(memoryRoot, "work/client-a", ["hot-memory"]);

      const filePath = path.join(memoryRoot, "work", "client-a", "hot-memory.md");
      const exists = await fs.access(filePath).then(() => true, () => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("<!-- L0: work/client-a hot memory");
    });

    it("does not overwrite existing files", async () => {
      const domainDir = path.join(memoryRoot, "existing-domain");
      await fs.mkdir(domainDir, { recursive: true });

      const existingContent = "# Existing content\nDo not delete this!";
      await fs.writeFile(path.join(domainDir, "hot-memory.md"), existingContent, "utf-8");

      await scaffoldDomainFiles(memoryRoot, "existing-domain", ["hot-memory", "observations"]);

      // hot-memory should be unchanged
      const hotMemory = await fs.readFile(path.join(domainDir, "hot-memory.md"), "utf-8");
      expect(hotMemory).toBe(existingContent);

      // observations should be created
      const observations = await fs.readFile(path.join(domainDir, "observations.md"), "utf-8");
      expect(observations).toContain("# Observations");
    });

    it("handles all standard file types", async () => {
      const allFiles = [
        "hot-memory",
        "observations",
        "action-items",
        "entities",
        "health",
        "calendar",
        "dev-log",
        "habits",
        "projects",
      ];

      await scaffoldDomainFiles(memoryRoot, "full-domain", allFiles);

      const domainDir = path.join(memoryRoot, "full-domain");

      for (const file of allFiles) {
        const filePath = path.join(domainDir, `${file}.md`);
        const exists = await fs.access(filePath).then(() => true, () => false);
        expect(exists).toBe(true);

        const content = await fs.readFile(filePath, "utf-8");
        expect(content).toContain("<!-- L0:");
        expect(content).toContain("#");
      }
    });

    it("creates correct titles from file names", async () => {
      await scaffoldDomainFiles(memoryRoot, "test", ["action-items", "dev-log"]);

      const domainDir = path.join(memoryRoot, "test");

      const actionItems = await fs.readFile(path.join(domainDir, "action-items.md"), "utf-8");
      expect(actionItems).toContain("# Action Items");

      const devLog = await fs.readFile(path.join(domainDir, "dev-log.md"), "utf-8");
      expect(devLog).toContain("# Dev Log");
    });
  });
});
