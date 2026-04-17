/**
 * Domain Manager Extension
 *
 * Manages COG memory domain lifecycle: create, list, archive.
 * Keeps memory/domains.yml (COG SSOT) and data/telegram-map.yaml in sync.
 *
 * Tools: create_domain, list_domains, archive_domain
 * Commands: /domain-create, /domain-list
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { loadYamlFile } from "../../../shared/lib/yaml-helpers";
import { formatError } from "../../../shared/lib/error-helpers.ts";
import { type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type CogDomain, type DomainsManifest, readDomainsManifest } from "../../../shared/lib/domains.ts";
import { createLogger } from "../../lib/logger.ts";
import { fileExists } from "../../../shared/lib/fs-helpers.ts";
import { getGlobalManager } from "../../lib/shared-state.ts";

const logger = createLogger({ context: { component: "domain-manager" } });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DomainManagerOptions {
  memoryRoot: string;
  dataRoot: string;
  projectRoot: string;
  getDomain: () => string;  // Dynamic domain accessor
}

interface TelegramTopic {
  thread_id: number | null;
  created_at: string;
  archived?: boolean;
}

interface TelegramMap {
  telegram: { bot_token_env: string; supergroup_id?: number };
  topics: Record<string, TelegramTopic>;
}

// ── YAML helpers ──────────────────────────────────────────────────────────────

async function writeDomainsManifest(memoryRoot: string, manifest: DomainsManifest): Promise<void> {
  const filePath = path.join(memoryRoot, "domains.yml");
  const header = "# Majordomo Domain Manifest — managed by domain-manager extension\n# To add domains: ask Majordomo to create one\n\n";
  await fs.writeFile(filePath, header + yaml.dump(manifest, { lineWidth: 120 }), "utf-8");
}

async function readTelegramMap(dataRoot: string): Promise<TelegramMap> {
  const filePath = path.join(dataRoot, "telegram-map.yaml");
  return loadYamlFile<TelegramMap>(filePath, { telegram: { bot_token_env: "TELEGRAM_BOT_TOKEN" }, topics: {} });
}

async function writeTelegramMap(dataRoot: string, map: TelegramMap): Promise<void> {
  const filePath = path.join(dataRoot, "telegram-map.yaml");
  const header = "# Telegram topic → domain mapping\n# Managed by domain-manager. NOT part of COG memory.\n\n";
  await fs.writeFile(filePath, header + yaml.dump(map, { lineWidth: 120 }), "utf-8");
}

// ── Standard COG files per domain type ───────────────────────────────────────

const DEFAULT_FILES: Record<string, string[]> = {
  personal: ["hot-memory", "observations", "action-items", "entities", "health", "calendar"],
  work:     ["hot-memory", "observations", "action-items", "entities", "dev-log"],
  project:  ["hot-memory", "observations", "action-items", "entities", "dev-log"],
  general:  ["hot-memory", "observations", "action-items"],
  custom:   ["hot-memory", "observations", "action-items"],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Domain command file generator ─────────────────────────────────────────────

// Converts a domain id like "work/acme" to a command filename "work-acme"
function domainCommandId(id: string): string {
  return id.replace(/\//g, "-");
}

async function generateDomainCommand(
  domain: CogDomain,
  projectRoot: string
): Promise<void> {
  const templatePath = path.join(projectRoot, ".claude", "commands", "_templates", "domain.md");
  const commandId = domainCommandId(domain.id);
  const commandPath = path.join(projectRoot, ".claude", "commands", `${commandId}.md`);

  // Never overwrite an existing hand-crafted command file
  const exists = await fileExists(commandPath);
  if (exists) return;

  let template: string;
  try {
    template = await fs.readFile(templatePath, "utf-8");
  } catch (err) {
    logger.warn("Template not found, skipping command generation", { templatePath, error: err });
    return;
  }

  // {{TRIGGERS}} — one bullet per keyword, or a generic fallback
  const triggerBullets = domain.triggers.length > 0
    ? domain.triggers.map(t => `- ${t}`).join("\n")
    : `- Topics related to ${domain.label}`;

  // {{FILES}} — backtick-quoted comma-separated list of filenames
  const fileList = domain.files.map(f => `\`${f}.md\``).join(", ");

  const rendered = template
    .replace(/\{\{ID\}\}/g, domain.id)
    .replace(/\{\{LABEL\}\}/g, domain.label)
    .replace(/\{\{PATH\}\}/g, domain.path)
    .replace(/\{\{TRIGGERS\}\}/g, triggerBullets)
    .replace(/\{\{FILES\}\}/g, fileList);

  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, rendered, "utf-8");
  logger.info("Generated .claude/commands file", { file: `${commandId}.md` });
}

async function removeDomainCommand(domainId: string, projectRoot: string): Promise<void> {
  const commandId = domainCommandId(domainId);
  const commandPath = path.join(projectRoot, ".claude", "commands", `${commandId}.md`);
  try {
    await fs.unlink(commandPath);
    logger.info("Removed .claude/commands file", { file: `${commandId}.md` });
  } catch (err) {
    logger.debug("Command file didn't exist", { commandPath, error: err });
  }
}

async function scaffoldDomainFiles(memoryRoot: string, domainPath: string, files: string[]): Promise<void> {
  const domainDir = path.join(memoryRoot, domainPath);
  await fs.mkdir(domainDir, { recursive: true });

  const l0Map: Record<string, string> = {
    "hot-memory":    `${domainPath} hot memory — current state summary`,
    "observations":  `${domainPath} observations — append-only timestamped events`,
    "action-items":  `${domainPath} tasks — open and completed action items`,
    "entities":      `${domainPath} entities — people, orgs, and named things registry`,
    "health":        `${domainPath} health — current state and medical history`,
    "calendar":      `${domainPath} calendar — scheduled events and appointments`,
    "dev-log":       `${domainPath} dev log — development notes and decisions`,
    "habits":        `${domainPath} habits — current tracking and patterns`,
    "projects":      `${domainPath} projects — active and completed project list`,
  };

  for (const file of files) {
    const filePath = path.join(domainDir, `${file}.md`);
    const exists = await fileExists(filePath);
    if (exists) continue; // Don't overwrite existing files

    const l0 = l0Map[file] ?? `${domainPath} ${file}`;
    const title = file.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const content = `<!-- L0: ${l0} -->\n# ${title}\n`;
    await fs.writeFile(filePath, content, "utf-8");
  }
}

// ── Extension factory ─────────────────────────────────────────────────────────

export function domainManagerExtensionFactory(opts: DomainManagerOptions) {
  return (pi: ExtensionAPI) => {
    const { memoryRoot, dataRoot, projectRoot, getDomain } = opts;

    // ── create_domain tool ───────────────────────────────────────────────────

    pi.registerTool({
      name: "create_domain",
      label: "Create Domain",
      description:
        "Create a new COG memory domain. This creates the memory directory, standard COG files with L0 headers, updates memory/domains.yml, and reserves a slot in the Telegram mapping. The web UI will show a new tab for this domain.\n\n" +
        "⚠️  Security: workingDir sets the working directory for subagents spawned in this domain. Only provide trusted, absolute paths. " +
        "The directory must exist and be accessible. For security, it's restricted to user home directories, /tmp, and the project root.",
      promptSnippet: "Create a new COG memory domain with standard file scaffold",
      parameters: Type.Object({
        id: Type.String({
          description: "Domain identifier — lowercase, no spaces, may use / for nesting (e.g. 'fitness', 'work/acme')",
        }),
        label: Type.String({ description: "Human-readable description, e.g. 'Fitness and nutrition tracking'" }),
        type: Type.String({
          description: "Domain type: personal, work, project, general, custom",
          default: "custom",
        }),
        triggers: Type.Array(Type.String(), {
          description: "Keywords that should route conversations to this domain",
        }),
        files: Type.Optional(Type.Array(Type.String(), {
          description: "Files to create. Defaults based on type. Options: hot-memory, observations, action-items, entities, health, calendar, dev-log, habits, projects",
        })),
        workingDir: Type.Optional(Type.String({
          description: "Working directory for subagents spawned in this domain (absolute path, e.g. '/home/bjk/projects/myapp')",
        })),
      }),
      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        // Validate ID format and prevent path traversal
        if (!/^[a-z0-9/_-]+$/.test(params.id) || params.id.includes('..')) {
          return {
            content: [{ type: "text", text: "❌  Domain ID must be lowercase letters, numbers, hyphens, underscores, or slashes only (path traversal not allowed)" }],
            details: {},
          };
        }

        // Validate workingDir if provided
        if (params.workingDir) {
          // 1. Ensure it's an absolute path
          if (!path.isAbsolute(params.workingDir)) {
            return {
              content: [{ type: "text", text: `❌  workingDir must be an absolute path, got: ${params.workingDir}` }],
              details: { validation_error: "workingDir_not_absolute" },
            };
          }

          // 2. Verify directory exists and is accessible
          try {
            await fs.access(params.workingDir, fs.constants.R_OK | fs.constants.W_OK);
            const stat = await fs.stat(params.workingDir);
            if (!stat.isDirectory()) {
              return {
                content: [{ type: "text", text: `❌  workingDir must be a directory, got: ${params.workingDir}` }],
                details: { validation_error: "workingDir_not_directory" },
              };
            }
          } catch (err) {
            const message = formatError(err);
            return {
              content: [{ 
                type: "text", 
                text: `❌  workingDir '${params.workingDir}' does not exist or is not accessible: ${message}` 
              }],
              details: { validation_error: "workingDir_inaccessible", error: message },
            };
          }

          // 3. Restrict to allowed parent directories for security
          // Cross-platform home directory: Linux/macOS (HOME), Windows (USERPROFILE), containers (/root)
          const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/root";
          const allowedPrefixes = [
            homeDir,
            '/tmp',
            '/var/tmp',
            projectRoot,
          ].filter(Boolean) as string[];

          const isAllowed = allowedPrefixes.some(prefix => {
            const resolved = path.resolve(params.workingDir!);
            const normalizedPrefix = path.resolve(prefix);
            return resolved.startsWith(normalizedPrefix);
          });

          if (!isAllowed) {
            const allowedList = allowedPrefixes.join(', ');
            return {
              content: [{ 
                type: "text", 
                text: `❌  workingDir '${params.workingDir}' is outside allowed directories. Allowed: ${allowedList}` 
              }],
              details: { validation_error: "workingDir_not_allowed", allowed_prefixes: allowedPrefixes },
            };
          }
        }

        // Check for duplicates
        const manifest = await readDomainsManifest(memoryRoot);
        const existing = manifest.domains.find(d => d.id === params.id);
        if (existing && existing.status !== "archived") {
          return {
            content: [{ type: "text", text: `❌  Domain '${params.id}' already exists` }],
            details: { id: params.id, existing: true },
          };
        }

        // Determine files
        const files = params.files ?? DEFAULT_FILES[params.type] ?? DEFAULT_FILES.custom;

        // Create COG directory and scaffold files
        await scaffoldDomainFiles(memoryRoot, params.id, files);

        // Update domains.yml
        const newDomain: CogDomain = {
          id: params.id,
          path: params.id,
          type: params.type,
          label: params.label,
          triggers: params.triggers,
          files,
          status: "active",
          created_at: today(),
          ...(params.workingDir ? { workingDir: params.workingDir } : {}),
        };

        if (existing) {
          // Re-activate archived domain
          const idx = manifest.domains.findIndex(d => d.id === params.id);
          manifest.domains[idx] = newDomain;
        } else {
          manifest.domains.push(newDomain);
        }

        await writeDomainsManifest(memoryRoot, manifest);

        // Update telegram map (reserve slot, no thread_id yet)
        const telegramMap = await readTelegramMap(dataRoot);
        if (!telegramMap.topics[params.id]) {
          telegramMap.topics[params.id] = {
            thread_id: null,
            created_at: today(),
          };
          await writeTelegramMap(dataRoot, telegramMap);
        }

        // Create sessions directory
        const sessionsDir = path.join(dataRoot, "sessions", params.id);
        await fs.mkdir(sessionsDir, { recursive: true });

        // Generate .claude/commands/{id}.md from template
        await generateDomainCommand(newDomain, projectRoot);

        // Emit event for web bridge
        pi.events.emit("domain:created", { id: params.id, label: params.label, type: params.type });

        return {
          content: [{
            type: "text",
            text: [
              `✓  Domain '${params.id}' created`,
              `   Label: ${params.label}`,
              `   Files: ${files.join(", ")}`,
              `   Memory: memory/${params.id}/`,
              `   Sessions: data/sessions/${params.id}/`,
              `   Note: Telegram thread_id not yet assigned — assign when adding Telegram integration`,
            ].join("\n"),
          }],
          details: { id: params.id, label: params.label, files },
        };
      },
    });

    // ── list_domains tool ────────────────────────────────────────────────────

    pi.registerTool({
      name: "list_domains",
      label: "List Domains",
      description: "List all COG memory domains from memory/domains.yml, including their labels, types, and status.",
      promptSnippet: "List all configured COG memory domains",
      parameters: Type.Object({
        include_archived: Type.Optional(Type.Boolean({ description: "Include archived domains", default: false })),
      }),
      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        const manifest = await readDomainsManifest(memoryRoot);
        let domains = manifest.domains;
        if (!params.include_archived) {
          domains = domains.filter(d => d.status !== "archived");
        }

        if (domains.length === 0) {
          return {
            content: [{ type: "text", text: "No domains configured yet. Use create_domain to add one." }],
            details: { domains: [] },
          };
        }

        const text = domains.map(d => {
          const status = d.status === "archived" ? " [archived]" : "";
          return `- **${d.id}**${status}: ${d.label} (${d.type}) — triggers: ${d.triggers.join(", ") || "none"}`;
        }).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { domains },
        };
      },
    });

    // ── archive_domain tool ──────────────────────────────────────────────────

    pi.registerTool({
      name: "archive_domain",
      label: "Archive Domain",
      description:
        "Archive a COG domain. Moves memory files to memory/glacier/{domain}/, marks Telegram topic as archived in telegram-map.yaml. Does NOT delete anything — fully reversible.",
      promptSnippet: "Archive a COG memory domain (reversible)",
      parameters: Type.Object({
        id: Type.String({ description: "Domain ID to archive" }),
        confirm: Type.Boolean({ description: "Must be true to confirm the archival" }),
      }),
      async execute(_toolId, params): Promise<AgentToolResult<Record<string, unknown>>> {
        if (!params.confirm) {
          return {
            content: [{ type: "text", text: "❌  Set confirm: true to proceed with archival" }],
            details: {},
          };
        }

        const manifest = await readDomainsManifest(memoryRoot);
        const domainEntry = manifest.domains.find(d => d.id === params.id);

        if (!domainEntry || domainEntry.status === "archived") {
          return {
            content: [{ type: "text", text: `❌  Domain '${params.id}' not found or already archived` }],
            details: { id: params.id },
          };
        }

        // Move memory directory to glacier
        const sourcePath = path.join(memoryRoot, params.id);
        const glacierPath = path.join(memoryRoot, "glacier", params.id);

        try {
          await fs.mkdir(path.dirname(glacierPath), { recursive: true });
          await fs.rename(sourcePath, glacierPath);
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌  Could not move memory/${params.id} to glacier: ${err}` }],
            details: { id: params.id },
          };
        }

        // Mark as archived in domains.yml
        const idx = manifest.domains.findIndex(d => d.id === params.id);
        manifest.domains[idx].status = "archived";
        await writeDomainsManifest(memoryRoot, manifest);

        // Mark in telegram map
        const telegramMap = await readTelegramMap(dataRoot);
        if (telegramMap.topics[params.id]) {
          telegramMap.topics[params.id].archived = true;
          await writeTelegramMap(dataRoot, telegramMap);
        }

        // Move session files
        const sessionSrc = path.join(dataRoot, "sessions", params.id);
        const sessionDst = path.join(dataRoot, "sessions", ".archived", params.id);
        try {
          await fs.mkdir(path.dirname(sessionDst), { recursive: true });
          await fs.rename(sessionSrc, sessionDst);
        } catch (err) {
          logger.debug("Session dir may not exist", { sessionSrc, error: err });
        }

        // Remove generated command file
        await removeDomainCommand(params.id, projectRoot);

        // Emit event for web bridge
        pi.events.emit("domain:deleted", { id: params.id });

        return {
          content: [{
            type: "text",
            text: [
              `✓  Domain '${params.id}' archived`,
              `   Memory moved: memory/${params.id}/ → memory/glacier/${params.id}/`,
              `   Sessions moved: data/sessions/${params.id}/ → data/sessions/.archived/${params.id}/`,
              `   Fully reversible — run create_domain to re-activate`,
            ].join("\n"),
          }],
          details: { id: params.id, archived: true },
        };
      },
    });

    // ── /domain-create command ───────────────────────────────────────────────

    pi.registerCommand("domain-create", {
      description: "Create a new COG domain interactively",
      handler: async (args, ctx) => {
        if (!args) {
          ctx.ui.notify("Usage: /domain-create <id> — then provide label and triggers when prompted", "info");
          return;
        }
        const id = args.trim().toLowerCase().replace(/\s+/g, "-");
        ctx.ui.notify(`Creating domain '${id}' — ask Majordomo to configure it fully`, "info");
        pi.sendUserMessage(`Please create a new domain with id '${id}'. Ask me for the label and trigger keywords if you need them.`, { deliverAs: "followUp" });
      },
    });

    // ── /domain-list command ─────────────────────────────────────────────────

    pi.registerCommand("domain-list", {
      description: "List all configured COG domains",
      handler: async (_args, ctx) => {
        const manifest = await readDomainsManifest(memoryRoot);
        const active = manifest.domains.filter(d => d.status !== "archived");
        if (active.length === 0) {
          ctx.ui.notify("No domains configured. Use /domain-create <id> to add one.", "info");
          return;
        }
        const list = active.map(d => `• ${d.id}: ${d.label}`).join("\n");
        ctx.ui.notify(`Domains:\n${list}`, "info");
      },
    });

    // ── suggest_domain_switch tool ───────────────────────────────────────────

    pi.registerTool({
      name: "suggest_domain_switch",
      label: "Suggest Domain Switch",
      description:
        "Suggest switching to a different domain when you notice the conversation has shifted to a different domain's territory. This does NOT switch — it just asks the user for confirmation. The agent MUST ask the user if they want to switch before calling this.",
      promptSnippet: "Ask user if they want to switch to a different domain",
      parameters: Type.Object({
        suggested_domain: Type.String({
          description: "Domain ID to suggest switching to (must exist in domains.yml)",
        }),
        reason: Type.String({
          description: "Brief reason why this domain is more appropriate for the current conversation",
        }),
      }),
      async execute(_toolId, params): Promise<AgentToolResult<Record<string, unknown>>> {
        // Validate domain exists
        const manifest = await readDomainsManifest(memoryRoot);
        const targetDomain = manifest.domains.find(
          d => d.id === params.suggested_domain && d.status !== "archived"
        );

        if (!targetDomain) {
          return {
            content: [{
              type: "text",
              text: `❌ Domain '${params.suggested_domain}' not found or archived. Use list_domains to see available domains.`,
            }],
            details: { valid: false },
          };
        }

        // Get current domain from getDomain accessor
        const currentDomain = getDomain();

        // Emit SSE event for web UI
        pi.events.emit("domain:switch_suggested", {
          from: currentDomain,
          to: params.suggested_domain,
          reason: params.reason,
        });

        // Return message for agent to present to user
        return {
          content: [{
            type: "text",
            text: `💡 Suggestion noted. Ask the user: "This sounds like **${params.suggested_domain}** work — want me to switch context? (yes/no)"`,
          }],
          details: {
            suggested_domain: params.suggested_domain,
            reason: params.reason,
            from: currentDomain,
          },
        };
      },
    });

    // ── confirm_domain_switch tool ───────────────────────────────────────────

    pi.registerTool({
      name: "confirm_domain_switch",
      label: "Confirm Domain Switch",
      description:
        "Execute a domain switch after the user has confirmed. Only call this after the user explicitly agrees to switch (either from a suggestion or an explicit request like '/switch X' or 'switch to X domain').",
      promptSnippet: "Switch to a different domain after user confirmation",
      parameters: Type.Object({
        domain: Type.String({
          description: "Domain ID to switch to",
        }),
      }),
      async execute(_toolId, params): Promise<AgentToolResult<Record<string, unknown>>> {
        // Validate domain exists
        const manifest = await readDomainsManifest(memoryRoot);
        const targetDomain = manifest.domains.find(
          d => d.id === params.domain && d.status !== "archived"
        );

        if (!targetDomain) {
          return {
            content: [{
              type: "text",
              text: `❌ Domain '${params.domain}' not found or archived. Use list_domains to see available domains.`,
            }],
            details: { success: false },
          };
        }

        // Get the manager and switch domain
        const manager = getGlobalManager();

        try {
          await manager.switchDomain(params.domain);

          return {
            content: [{
              type: "text",
              text: `✅ Switched to **${params.domain}** domain.`,
            }],
            details: {
              success: true,
              domain: params.domain,
            },
          };
        } catch (err) {
          const message = formatError(err);
          return {
            content: [{
              type: "text",
              text: `❌ Failed to switch domain: ${message}`,
            }],
            details: { success: false, error: message },
          };
        }
      },
    });
  };
}

// ── Default export for standalone loading ─────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const memoryRoot = process.env.MAJORDOMO_MEMORY_ROOT ?? path.join(process.cwd(), "memory");
  const dataRoot = process.env.MAJORDOMO_DATA_ROOT ?? path.join(process.cwd(), "data");
  const projectRoot = process.env.MAJORDOMO_PROJECT_ROOT ?? process.cwd();
  const getDomain = () => process.env.MAJORDOMO_DOMAIN ?? "general";
  domainManagerExtensionFactory({ memoryRoot, dataRoot, projectRoot, getDomain })(pi);
}
