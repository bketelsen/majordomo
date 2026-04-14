import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";

// Schema and functions for subagent run tracking
interface RunRecord {
  id: string;
  agent: string;
  status: "running" | "done" | "failed";
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  retries: number;
}

function openRunsDb(dataRoot: string): Database {
  const db = new Database(path.join(dataRoot, "subagents.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'running',
      input       TEXT NOT NULL,
      output      TEXT,
      error       TEXT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      retries     INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function createRun(db: Database, agent: string, input: Record<string, unknown>): RunRecord {
  const id = `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO runs (id, agent, status, input, started_at)
    VALUES (?, ?, 'running', ?, ?)
  `).run(id, agent, JSON.stringify(input), Date.now());
  return { id, agent, status: "running", input, startedAt: Date.now(), retries: 0 };
}

function updateRun(
  db: Database,
  id: string,
  fields: Partial<Pick<RunRecord, "status" | "output" | "error" | "retries" | "finishedAt">>
): void {
  if (fields.status !== undefined) {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(fields.status, id);
  }
  if (fields.output !== undefined) {
    db.prepare("UPDATE runs SET output = ? WHERE id = ?").run(fields.output, id);
  }
  if (fields.error !== undefined) {
    db.prepare("UPDATE runs SET error = ? WHERE id = ?").run(fields.error, id);
  }
  if (fields.retries !== undefined) {
    db.prepare("UPDATE runs SET retries = ? WHERE id = ?").run(fields.retries, id);
  }
  if (fields.finishedAt !== undefined) {
    db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(fields.finishedAt, id);
  }
}

function getRun(db: Database, id: string): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as string,
    agent: row.agent as string,
    status: row.status as RunRecord["status"],
    input: JSON.parse(row.input as string),
    output: row.output as string | undefined,
    error: row.error as string | undefined,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | undefined,
    retries: row.retries as number,
  };
}

function getRecentRuns(db: Database, limit = 10): RunRecord[] {
  const rows = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    agent: row.agent as string,
    status: row.status as RunRecord["status"],
    input: JSON.parse(row.input as string),
    output: row.output as string | undefined,
    error: row.error as string | undefined,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | undefined,
    retries: row.retries as number,
  }));
}

describe("Subagent Manager - Run Tracking", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "subagent-test-"));
    db = openRunsDb(tempDir);
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("openRunsDb() creates schema", () => {
    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("runs");
  });

  it("createRun() inserts a record", () => {
    const input = { task: "test task", priority: "high" };
    const run = createRun(db, "researcher", input);

    expect(run.id).toBeDefined();
    expect(run.id).toContain("researcher");
    expect(run.agent).toBe("researcher");
    expect(run.status).toBe("running");
    expect(run.input).toEqual(input);
    expect(run.retries).toBe(0);
  });

  it("updateRun() updates status/output/error", () => {
    const run = createRun(db, "developer", { task: "implement feature" });

    // Update status
    updateRun(db, run.id, { status: "done" });
    let retrieved = getRun(db, run.id);
    expect(retrieved?.status).toBe("done");

    // Update output
    updateRun(db, run.id, { output: "Feature implemented successfully" });
    retrieved = getRun(db, run.id);
    expect(retrieved?.output).toBe("Feature implemented successfully");

    // Update error
    updateRun(db, run.id, { error: "Test error", status: "failed" });
    retrieved = getRun(db, run.id);
    expect(retrieved?.error).toBe("Test error");
    expect(retrieved?.status).toBe("failed");
  });

  it("updateRun() updates retries and finishedAt", () => {
    const run = createRun(db, "qa", { task: "test app" });
    const finishTime = Date.now();

    updateRun(db, run.id, { retries: 2, finishedAt: finishTime });

    const retrieved = getRun(db, run.id);
    expect(retrieved?.retries).toBe(2);
    expect(retrieved?.finishedAt).toBe(finishTime);
  });

  it("getRun() retrieves by ID", () => {
    const input = { query: "What is TypeScript?" };
    const run = createRun(db, "researcher", input);

    const retrieved = getRun(db, run.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(run.id);
    expect(retrieved?.agent).toBe("researcher");
    expect(retrieved?.input).toEqual(input);
  });

  it("getRun() returns null for non-existent ID", () => {
    const retrieved = getRun(db, "nonexistent-id");
    expect(retrieved).toBeNull();
  });

  it("getRecentRuns() returns sorted by started_at desc", () => {
    // Create runs with slight delays to ensure different timestamps
    createRun(db, "agent1", { task: "first" });
    // Small delay to ensure different timestamp
    const start2 = Date.now() + 10;
    db.prepare(`
      INSERT INTO runs (id, agent, status, input, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run("agent2-test", "agent2", JSON.stringify({ task: "second" }), start2);

    const start3 = Date.now() + 20;
    db.prepare(`
      INSERT INTO runs (id, agent, status, input, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run("agent3-test", "agent3", JSON.stringify({ task: "third" }), start3);

    const recent = getRecentRuns(db, 10);

    expect(recent.length).toBe(3);
    // Most recent should be first
    expect(recent[0].agent).toBe("agent3");
    expect(recent[1].agent).toBe("agent2");
    expect(recent[2].agent).toBe("agent1");
  });

  it("getRecentRuns() respects limit", () => {
    // Create 5 runs
    for (let i = 0; i < 5; i++) {
      createRun(db, `agent${i}`, { task: `task${i}` });
    }

    const recent = getRecentRuns(db, 3);
    expect(recent.length).toBe(3);
  });

  it("full lifecycle: create → update → retrieve", () => {
    const input = { task: "build feature", complexity: "high" };
    const run = createRun(db, "developer", input);

    expect(run.status).toBe("running");

    // Simulate progress
    updateRun(db, run.id, { status: "done", output: "Feature built", finishedAt: Date.now() });

    const final = getRun(db, run.id);
    expect(final?.status).toBe("done");
    expect(final?.output).toBe("Feature built");
    expect(final?.finishedAt).toBeDefined();
  });
});
