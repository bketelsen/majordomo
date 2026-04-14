/**
 * Telegram Bot
 *
 * Single-chat Telegram bridge for the single-session architecture.
 *
 * - All inbound messages go to the active DomainContextManager domain
 * - `/switch <domain>` is handled by the agent/session itself
 * - Outbound relay from web/service goes back to the configured chat
 * - Legacy telegram-map.yaml is still read for supergroup_id compatibility,
 *   but forum topics are no longer used
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { Bot, type Context } from "grammy";
import type { DomainContextManager } from "./domain-context-manager.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TelegramBotOptions {
  manager: DomainContextManager;
  dataRoot: string;
  token?: string; // TELEGRAM_BOT_TOKEN env var if not provided
}

interface TelegramMap {
  telegram: { bot_token_env: string; supergroup_id?: number | null };
  topics?: Record<string, { thread_id: number | null; created_at: string; archived?: boolean }>;
}

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_REFRESH_MS = 4000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length > MAX_MESSAGE_LENGTH) {
      for (const line of paragraph.split("\n")) {
        if (current.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
          if (current.trim()) chunks.push(current.trim());
          current = line;
        } else {
          current += (current ? "\n" : "") + line;
        }
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > MAX_MESSAGE_LENGTH) {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += (current ? "\n\n" : "") + paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// ── Bot ───────────────────────────────────────────────────────────────────────

export class TelegramBot {
  private bot: Bot;
  private map: TelegramMap = { telegram: { bot_token_env: "TELEGRAM_BOT_TOKEN" }, topics: {} };
  private allowedChatId: number | null = null;
  private lastSeenChatId: number | null = null;
  private running = false;

  constructor(private opts: TelegramBotOptions) {
    const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    this.bot = new Bot(token);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.loadMap();

    this.allowedChatId = this.map.telegram.supergroup_id ?? null;
    if (!this.allowedChatId) {
      console.warn("[telegram] supergroup_id not configured in data/telegram-map.yaml");
      console.warn("[telegram] Send any message to the bot and it will log the chat ID");
    }

    this.registerHandlers();

    this.running = true;
    console.log("[telegram] Starting bot (long-polling)...");

    this.bot.start({
      onStart: (info) => console.log(`[telegram] Bot @${info.username} is running`),
      drop_pending_updates: true,
    }).catch(err => {
      if (this.running) console.error("[telegram] Polling error:", err);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.bot.stop();
    console.log("[telegram] Bot stopped");
  }

  async sendToDomain(_domain: string, text: string): Promise<void> {
    const chatId = this.allowedChatId ?? this.lastSeenChatId;
    if (!chatId) return;
    await this.sendChunks(chatId, text);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private registerHandlers(): void {
    this.bot.on("message", async (ctx) => {
      const chatId = ctx.chat.id;
      this.lastSeenChatId = chatId;

      if (!this.allowedChatId) {
        console.log(`[telegram] Received message from chat ID: ${chatId} (type: ${ctx.chat.type})`);
        if (ctx.chat.type === "supergroup") {
          console.log(`[telegram] 💡 Set supergroup_id: ${chatId} in data/telegram-map.yaml`);
        }
      }

      if (this.allowedChatId && chatId !== this.allowedChatId) return;
      if (ctx.from?.is_bot) return;

      await this.handleMessage(ctx);
    });

    this.bot.catch((err) => {
      console.error("[telegram] Unhandled error:", err.message);
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const text = msg.text ?? msg.caption;
    if (!text?.trim()) return;

    const domain = this.opts.manager.getDomain();
    console.log(`[telegram] Message in active domain '${domain}': ${text.slice(0, 60)}`);

    if (this.opts.manager.isStreaming()) {
      await this.reply(ctx, "⏳ Still processing a previous message — please wait a moment.");
      return;
    }

    const chatId = ctx.chat!.id;
    const typingInterval = this.startTyping(chatId);

    try {
      const response = await this.opts.manager.sendMessage(text);
      clearInterval(typingInterval);

      if (!response.trim()) {
        await this.reply(ctx, "✓");
        return;
      }

      for (const chunk of splitMessage(response)) {
        await this.sendChunks(chatId, chunk);
      }
    } catch (err) {
      clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Error processing message in domain '${domain}':`, message);
      await this.reply(ctx, `❌ Error: ${message}`);
    }
  }

  // ── Typing indicator ────────────────────────────────────────────────────────

  private startTyping(chatId: number): ReturnType<typeof setInterval> {
    const send = () => {
      this.bot.api.sendChatAction(chatId, "typing").catch(() => { /* ignore */ });
    };
    send();
    return setInterval(send, TYPING_REFRESH_MS);
  }

  // ── Sending helpers ─────────────────────────────────────────────────────────

  private async reply(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text);
    } catch (err) {
      console.error("[telegram] Failed to reply:", err);
    }
  }

  private async sendChunks(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (err) {
      console.error("[telegram] Failed to send message:", err);
    }
  }

  // ── telegram-map.yaml I/O ───────────────────────────────────────────────────

  private async loadMap(): Promise<void> {
    const filePath = path.join(this.opts.dataRoot, "telegram-map.yaml");
    try {
      const content = await fs.readFile(filePath, "utf-8");
      this.map = (yaml.load(content) as TelegramMap) ?? this.map;
    } catch {
      console.warn("[telegram] telegram-map.yaml not found, using defaults");
    }
  }
}
