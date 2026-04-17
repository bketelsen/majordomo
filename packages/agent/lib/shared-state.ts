/**
 * Type-safe globalThis pattern for shared instances
 *
 * Provides type-safe access to shared singleton instances that need to be
 * accessed across different modules (e.g., web server, Telegram bot, extensions).
 */

import type { EventEmitter } from "node:events";
import type { DomainContextManager } from "./domain-context-manager.ts";
import type { TelegramBot } from "./telegram-bot.ts";

// Extend globalThis interface with our shared instances
declare global {
  // eslint-disable-next-line no-var
  var __majordomoManager: DomainContextManager | undefined;
  // eslint-disable-next-line no-var
  var __majordomoWebEvents: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __majordomoTelegram: TelegramBot | null | undefined;
}

/**
 * Set the global DomainContextManager instance
 */
export function setGlobalManager(manager: DomainContextManager): void {
  globalThis.__majordomoManager = manager;
}

/**
 * Get the global DomainContextManager instance
 * @throws Error if manager is not initialized
 */
export function getGlobalManager(): DomainContextManager {
  if (!globalThis.__majordomoManager) {
    throw new Error("DomainContextManager not initialized");
  }
  return globalThis.__majordomoManager;
}

/**
 * Try to get the global DomainContextManager instance
 * @returns DomainContextManager instance or undefined if not initialized
 */
export function tryGetGlobalManager(): DomainContextManager | undefined {
  return globalThis.__majordomoManager;
}

/**
 * Set the global web events EventEmitter instance
 */
export function setGlobalWebEvents(events: EventEmitter): void {
  globalThis.__majordomoWebEvents = events;
}

/**
 * Get the global web events EventEmitter instance
 * @throws Error if web events are not initialized
 */
export function getGlobalWebEvents(): EventEmitter {
  if (!globalThis.__majordomoWebEvents) {
    throw new Error("Web events not initialized");
  }
  return globalThis.__majordomoWebEvents;
}

/**
 * Set the global TelegramBot instance (or null if disabled)
 */
export function setGlobalTelegram(telegram: TelegramBot | null): void {
  globalThis.__majordomoTelegram = telegram;
}

/**
 * Get the global TelegramBot instance (may be null if Telegram is disabled)
 */
export function getGlobalTelegram(): TelegramBot | null {
  return globalThis.__majordomoTelegram ?? null;
}

/**
 * Clear all global instances (useful for testing)
 */
export function clearGlobalState(): void {
  globalThis.__majordomoManager = undefined;
  globalThis.__majordomoWebEvents = undefined;
  globalThis.__majordomoTelegram = undefined;
}
