/**
 * DomainContextManager
 *
 * Replaces DomainSessionPool in Phase 2 (single-session architecture).
 * Manages a single long-running pi AgentSession where domain context is
 * injected dynamically rather than isolated in separate processes.
 *
 * Key differences from DomainSessionPool:
 *   - Holds ONE AgentSession (not a map of sessions)
 *   - activeDomain is mutable state (switches without restarting session)
 *   - Extensions load once as singletons (getDomain accessor)
 *   - Unified session.jsonl (all domains)
 *
 * Phase 1: Built alongside DomainSessionPool (not wired into service.ts yet)
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  type EventBus,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { cogMemoryExtensionFactory } from "../extensions/cog-memory/index.ts";
import { domainManagerExtensionFactory } from "../extensions/domain-manager/index.ts";
import { subagentManagerExtensionFactory } from "../extensions/subagent-manager/index.ts";
import { schedulerExtensionFactory } from "../extensions/scheduler/index.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DomainContextManagerOptions {
  projectRoot: string;
  memoryRoot: string;
  dataRoot: string;
  personaFile: string;
  agentsDir: string;
  workflowsDir: string;
}

interface DomainsManifest {
  domains: Array<{ id: string; status?: string }>;
}

// ── Shared resources (one per process) ────────────────────────────────────────

export const sharedEventBus: EventBus = createEventBus();
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// ── DomainContextManager ──────────────────────────────────────────────────────

export class DomainContextManager {
  private session!: AgentSession;
  private activeDomain: string = "general";
  private currentMessageDomain: string = "general";
  private responseBuffer: string = "";
  private resolve?: (text: string) => void;
  private reject?: (err: Error) => void;
  private onToken?: (delta: string) => void;

  constructor(private opts: DomainContextManagerOptions) {}

  // ── Accessor for active domain ────────────────────────────────────────────

  getDomain(): string {
    return this.activeDomain;
  }

  // ── Initialize: create the single session with singleton extensions ──────

  async initialize(): Promise<void> {
    console.log("[manager] Initializing single-session architecture...");

    // Validate domains manifest exists
    const manifest = await this.readDomainsManifest();
    if (manifest.domains.length === 0) {
      throw new Error("No domains configured in memory/domains.yml");
    }

    // Load persona template once; active domain is substituted per prompt
    const personaTemplate = await this.loadPersonaTemplate();

    // Unified session file (all domains)
    const sessionFile = path.join(this.opts.dataRoot, "sessions", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    // Create resource loader with singleton extensions
    // Extensions use getDomain accessor instead of static domain
    const loader = new DefaultResourceLoader({
      cwd: this.opts.projectRoot,
      eventBus: sharedEventBus,
      systemPromptOverride: () => this.renderPersona(personaTemplate),
      extensionFactories: [
        cogMemoryExtensionFactory({
          memoryRoot: this.opts.memoryRoot,
          getDomain: () => this.getDomain(),
        }),
        domainManagerExtensionFactory({
          memoryRoot: this.opts.memoryRoot,
          dataRoot: this.opts.dataRoot,
          projectRoot: this.opts.projectRoot,
          getDomain: () => this.getDomain(),
        }),
        subagentManagerExtensionFactory({
          projectRoot: this.opts.projectRoot,
          agentsDir: this.opts.agentsDir,
          dataRoot: this.opts.dataRoot,
          memoryRoot: this.opts.memoryRoot,
          getDomain: () => this.getDomain(),
        }),
        schedulerExtensionFactory({
          projectRoot: this.opts.projectRoot,
          dataRoot: this.opts.dataRoot,
          agentsDir: this.opts.agentsDir,
        }),
      ],
    });

    await loader.reload();

    // Compaction: enabled, triggers at 80% context usage
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
    });

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.opts.projectRoot,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.open(sessionFile),
      settingsManager,
    });

    if (modelFallbackMessage) {
      console.warn(`[manager] Model fallback: ${modelFallbackMessage}`);
    }

    this.session = session;
    this.wireEvents();

    console.log(`[manager] Single session initialized (active domain: ${this.activeDomain})`);
  }

  // ── Switch domain ─────────────────────────────────────────────────────────

  async switchDomain(domainId: string): Promise<void> {
    // Validate domain exists and is not archived
    const manifest = await this.readDomainsManifest();
    const domain = manifest.domains.find(
      (d) => d.id === domainId && d.status !== "archived"
    );

    if (!domain) {
      throw new Error(
        `Domain '${domainId}' not found or archived. Use list_domains to see available domains.`
      );
    }

    console.log(`[manager] Switching domain: ${this.activeDomain} → ${domainId}`);
    this.activeDomain = domainId;

    // Emit event for web UI
    sharedEventBus.emit("domain:switched", { domain: domainId });

    // Next user message will trigger before_agent_start hook with new domain context
  }

  // ── Send message to the session ───────────────────────────────────────────

  async sendMessage(
    text: string,
    onToken?: (delta: string) => void
  ): Promise<string> {
    if (this.session.isStreaming) {
      throw new Error("Session is busy processing another message");
    }

    this.onToken = onToken;

    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.session.prompt(text).catch(reject);
    });
  }

  // ── List all active domains ───────────────────────────────────────────────

  async domains(): Promise<string[]> {
    const manifest = await this.readDomainsManifest();
    return manifest.domains
      .filter((d) => d.status !== "archived")
      .map((d) => d.id);
  }

  // ── Check if session is streaming ─────────────────────────────────────────

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.session.dispose();
  }

  // ── Private: wire session events to resolve promises ──────────────────────

  private wireEvents(): void {
    this.session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          this.currentMessageDomain = this.activeDomain;
          this.responseBuffer = "";
          break;

        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            this.responseBuffer += event.assistantMessageEvent.delta;
            this.onToken?.(event.assistantMessageEvent.delta);
            if (!this.onToken) {
              sharedEventBus.emit("agent:token", {
                domain: this.currentMessageDomain,
                delta: event.assistantMessageEvent.delta,
              });
            }
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            sharedEventBus.emit("agent:thinking", {
              domain: this.currentMessageDomain,
              delta: event.assistantMessageEvent.delta,
            });
          }
          break;

        case "tool_execution_start":
          sharedEventBus.emit("agent:tool_start", {
            domain: this.currentMessageDomain,
            toolName: event.toolName,
            args: event.args,
          });
          break;

        case "tool_execution_end":
          sharedEventBus.emit("agent:tool_end", {
            domain: this.currentMessageDomain,
            toolName: event.toolName,
            isError: event.isError,
          });
          break;

        case "agent_end": {
          const resolve = this.resolve;
          this.resolve = undefined;
          this.reject = undefined;
          this.onToken = undefined;
          if (resolve) {
            resolve(this.responseBuffer);
          } else {
            sharedEventBus.emit("agent:done", {
              domain: this.currentMessageDomain,
              text: this.responseBuffer,
            });
          }
          break;
        }
      }
    });
  }

  // ── Private: load persona with active domain substitution ─────────────────

  private async loadPersonaTemplate(): Promise<string> {
    try {
      return await fs.readFile(this.opts.personaFile, "utf-8");
    } catch {
      return "You are Majordomo, a personal AI chief-of-staff.\nActive domain: {{ACTIVE_DOMAIN}}";
    }
  }

  private renderPersona(template: string): string {
    return template.replace(/\{\{ACTIVE_DOMAIN\}\}/g, this.activeDomain);
  }

  // ── Private: read domains manifest ────────────────────────────────────────

  private async readDomainsManifest(): Promise<DomainsManifest> {
    const filePath = path.join(this.opts.memoryRoot, "domains.yml");
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return (yaml.load(content) as DomainsManifest) ?? { domains: [] };
    } catch {
      return { domains: [] };
    }
  }
}
