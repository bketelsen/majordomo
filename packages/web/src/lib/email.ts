/**
 * Email widget — IMAP polling via imapflow.
 *
 * Config via environment variables:
 *   IMAP_HOST      IMAP server hostname (e.g. imap.gmail.com)
 *   IMAP_PORT      Port, default 993
 *   IMAP_USER      Login username / email address
 *   IMAP_PASSWORD  Password or app-specific password
 *   IMAP_MAILBOX   Mailbox to fetch from, default INBOX
 *   IMAP_COUNT     Number of recent messages to fetch, default 10
 *
 * Returns null if IMAP is not configured (IMAP_HOST not set).
 * Cache TTL: 5 minutes.
 */

import { ImapFlow } from "imapflow";

export interface EmailMessage {
  uid: number;
  subject: string;
  from: string;
  date: string;
  read: boolean;
  flags: string[];
}

interface Cache {
  messages: EmailMessage[];
  fetchedAt: number;
}

let cache: Cache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function isConfigured(): boolean {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

export async function fetchRecentEmails(): Promise<{ messages: EmailMessage[]; configured: boolean }> {
  if (!isConfigured()) return { messages: [], configured: false };

  // Return cache if fresh
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { messages: cache.messages, configured: true };
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: parseInt(process.env.IMAP_PORT ?? "993"),
    secure: true,
    auth: {
      user: process.env.IMAP_USER!,
      pass: process.env.IMAP_PASSWORD!,
    },
    logger: false,
  });

  const messages: EmailMessage[] = [];

  try {
    await client.connect();
    const mailbox = process.env.IMAP_MAILBOX ?? "INBOX";
    const count = parseInt(process.env.IMAP_COUNT ?? "10");

    await client.mailboxOpen(mailbox);
    const total = (client.mailbox && typeof client.mailbox === 'object' && 'exists' in client.mailbox)
      ? (client.mailbox as { exists: number }).exists
      : 0;
    if (total === 0) {
      await client.logout();
      cache = { messages: [], fetchedAt: Date.now() };
      return { messages: [], configured: true };
    }

    // Fetch the last `count` messages
    const start = Math.max(1, total - count + 1);
    const range = `${start}:${total}`;

    for await (const msg of client.fetch(range, {
      envelope: true,
      flags: true,
    })) {
      const envelope = msg.envelope;
      const from = envelope?.from?.[0];
      const fromStr = from?.name
        ? `${from.name} <${from.address}>`
        : (from?.address ?? "unknown");

      messages.unshift({
        uid: msg.uid,
        subject: envelope?.subject ?? "(no subject)",
        from: fromStr,
        date: envelope?.date ? new Date(envelope.date).toLocaleDateString([], {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        }) : "",
        read: msg.flags ? msg.flags.has("\\Seen") : false,
        flags: msg.flags ? [...msg.flags] : [],
      });
    }

    await client.logout();
  } catch (err) {
    console.error("[email] IMAP fetch failed:", err);
    // Return stale cache on error rather than nothing
    if (cache) return { messages: cache.messages, configured: true };
    return { messages: [], configured: true };
  }

  cache = { messages, fetchedAt: Date.now() };
  return { messages, configured: true };
}

export async function markEmailRead(uid: number): Promise<boolean> {
  if (!isConfigured()) return false;

  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: parseInt(process.env.IMAP_PORT ?? "993"),
    secure: true,
    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen(process.env.IMAP_MAILBOX ?? "INBOX");
    await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true });
    await client.logout();

    // Invalidate cache so next fetch is fresh
    cache = null;
    return true;
  } catch {
    return false;
  }
}
