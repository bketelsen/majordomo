/**
 * Outline API client for Majordomo
 * 
 * Self-hosted wiki integration — create, read, update, delete documents.
 * All API calls use POST with JSON body (Outline's convention).
 */

import { createLogger } from "./logger.ts";

const logger = createLogger({ context: { component: "outline" } });

// ── Configuration ─────────────────────────────────────────────────────────────

export const OUTLINE_URL = process.env.OUTLINE_URL ?? 'http://10.0.1.102:3030';
export const OUTLINE_TOKEN = process.env.OUTLINE_TOKEN;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;  // markdown content
  collectionId: string;
  parentDocumentId?: string;
  url: string;
  updatedAt: string;
}

export interface OutlineCollection {
  id: string;
  name: string;
  description?: string;
  url: string;
}

interface OutlineResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── HTTP client ───────────────────────────────────────────────────────────────

function ensureToken(): string {
  if (!OUTLINE_TOKEN) {
    throw new Error(
      "OUTLINE_TOKEN environment variable not set. " +
      "Configure it in .env or export OUTLINE_TOKEN=your_api_token"
    );
  }
  return OUTLINE_TOKEN;
}

async function outlinePost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = ensureToken();
  const url = `${OUTLINE_URL}/api/${endpoint}`;

  logger.debug("Outline API request", { endpoint, body });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await response.json() as OutlineResponse<T>;

  if (!json.ok || json.error) {
    const errorMsg = json.error ?? `HTTP ${response.status}: ${response.statusText}`;
    logger.error("Outline API error", { endpoint, error: errorMsg });
    throw new Error(`Outline API error: ${errorMsg}`);
  }

  if (!json.data) {
    throw new Error(`Outline API returned ok:true but no data field`);
  }

  return json.data;
}

// ── Collections ───────────────────────────────────────────────────────────────

export async function getCollections(): Promise<OutlineCollection[]> {
  const data = await outlinePost<OutlineCollection[]>("collections.list");
  return Array.isArray(data) ? data : [];
}

export async function getOrCreateCollection(name: string, description?: string): Promise<OutlineCollection> {
  const collections = await getCollections();
  const existing = collections.find(c => c.name === name);
  
  if (existing) {
    logger.debug("Collection already exists", { name, id: existing.id });
    return existing;
  }

  logger.info("Creating new collection", { name, description });
  const collection = await outlinePost<OutlineCollection>("collections.create", {
    name,
    description,
    sharing: false,
  });

  return collection;
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function getDocuments(collectionId: string): Promise<OutlineDocument[]> {
  const data = await outlinePost<OutlineDocument[]>("documents.list", { collectionId });
  return Array.isArray(data) ? data : [];
}

export async function getDocument(id: string): Promise<OutlineDocument> {
  const doc = await outlinePost<OutlineDocument>("documents.info", { id });
  return doc;
}

export async function searchDocuments(query: string): Promise<OutlineDocument[]> {
  interface SearchResult {
    ranking: number;
    context: string;
    document: OutlineDocument;
  }
  const data = await outlinePost<SearchResult[]>("documents.search", { query });
  if (!Array.isArray(data)) return [];
  // Extract the document from each search result
  return data.map(result => result.document);
}

export interface CreateDocumentOptions {
  title: string;
  text: string;
  collectionId: string;
  parentDocumentId?: string;
  publish?: boolean;
}

export async function createDocument(opts: CreateDocumentOptions): Promise<OutlineDocument> {
  logger.info("Creating document", { title: opts.title, collectionId: opts.collectionId });
  const doc = await outlinePost<OutlineDocument>("documents.create", {
    title: opts.title,
    text: opts.text,
    collectionId: opts.collectionId,
    parentDocumentId: opts.parentDocumentId,
    publish: opts.publish ?? true,
  });
  return doc;
}

export interface UpdateDocumentOptions {
  title?: string;
  text?: string;
  publish?: boolean;
}

export async function updateDocument(id: string, opts: UpdateDocumentOptions): Promise<OutlineDocument> {
  logger.info("Updating document", { id, title: opts.title });
  const doc = await outlinePost<OutlineDocument>("documents.update", {
    id,
    ...opts,
  });
  return doc;
}

export async function deleteDocument(id: string): Promise<void> {
  logger.info("Deleting document", { id });
  // Delete returns { ok: true, success: true } with no data field
  const url = `${OUTLINE_URL}/api/documents.delete`;
  const token = ensureToken();
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id }),
  });

  const json = await response.json() as { ok: boolean; error?: string; success?: boolean };

  if (!json.ok || json.error) {
    const errorMsg = json.error ?? `HTTP ${response.status}: ${response.statusText}`;
    logger.error("Outline API error", { endpoint: "documents.delete", error: errorMsg });
    throw new Error(`Outline API error: ${errorMsg}`);
  }
}

// ── Availability check ────────────────────────────────────────────────────────

export async function isOutlineAvailable(): Promise<boolean> {
  if (!OUTLINE_TOKEN) {
    return false;
  }

  try {
    await getCollections();
    return true;
  } catch (err) {
    logger.debug("Outline availability check failed", { error: err });
    return false;
  }
}
