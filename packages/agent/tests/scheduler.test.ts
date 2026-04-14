import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";

interface ScheduledJob {
  id: string;
  cron: string;
  action_type: "pi_command" | "agent_prompt" | "webhook";
  action_data: string;
  enabled: number;
  created_at: string;
}

function openDb(dataRoot: string): Database {
  const dbPath = path.join(dataRoot, "scheduler.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      cron        TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_data TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT NOT NULL,
      ran_at     TEXT NOT NULL,
      success    INTEGER NOT NULL,
      error      TEXT
    );
  `);

  return db;
}

const COG_PIPELINE_JOBS = [
  { id: "cog-foresight-daily", cron: "0 7 * * *", command: "/cog-foresight" },
  { id: "cog-reflect-weekly", cron: "0 2 * * 0", command: "/cog-reflect" },
  { id: "cog-housekeeping-weekly", cron: "0 3 * * 0", command: "/cog-housekeeping" },
  { id: "cog-evolve-weekly", cron: "0 4 * * 0", command: "/cog-evolve" },
];

function ensureCogJobs(db: Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs (id, cron, action_type, action_data, enabled, created_at)
    VALUES (?, ?, 'pi_command', ?, 1, datetime('now'))
  `);

  for (const job of COG_PIPELINE_JOBS) {
    insert.run(job.id, job.cron, JSON.stringify({ command: job.command }));
  }
}

describe("Scheduler Database", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
    db = openDb(tempDir);
  });

  afterEach(async () => {
    if (db) {
      db.close();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("openDb() creates jobs and runs tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("jobs");
    expect(tableNames).toContain("runs");
  });

  it("ensureCogJobs() inserts the 4 COG pipeline jobs", () => {
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs").all() as ScheduledJob[];

    expect(jobs.length).toBe(4);

    const jobIds = jobs.map((j) => j.id);
    expect(jobIds).toContain("cog-foresight-daily");
    expect(jobIds).toContain("cog-reflect-weekly");
    expect(jobIds).toContain("cog-housekeeping-weekly");
    expect(jobIds).toContain("cog-evolve-weekly");
  });

  it("ensureCogJobs() is idempotent (INSERT OR IGNORE)", () => {
    ensureCogJobs(db);
    ensureCogJobs(db);
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs").all() as ScheduledJob[];
    expect(jobs.length).toBe(4);
  });

  it("jobs have correct cron expressions", () => {
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs ORDER BY id").all() as ScheduledJob[];

    const foresight = jobs.find((j) => j.id === "cog-foresight-daily");
    expect(foresight?.cron).toBe("0 7 * * *");

    const reflect = jobs.find((j) => j.id === "cog-reflect-weekly");
    expect(reflect?.cron).toBe("0 2 * * 0");

    const housekeeping = jobs.find((j) => j.id === "cog-housekeeping-weekly");
    expect(housekeeping?.cron).toBe("0 3 * * 0");

    const evolve = jobs.find((j) => j.id === "cog-evolve-weekly");
    expect(evolve?.cron).toBe("0 4 * * 0");
  });

  it("jobs have action_type = 'pi_command'", () => {
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs").all() as ScheduledJob[];

    for (const job of jobs) {
      expect(job.action_type).toBe("pi_command");
    }
  });

  it("jobs have correct command in action_data", () => {
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs").all() as ScheduledJob[];

    const foresight = jobs.find((j) => j.id === "cog-foresight-daily");
    const foresightData = JSON.parse(foresight!.action_data);
    expect(foresightData.command).toBe("/cog-foresight");

    const reflect = jobs.find((j) => j.id === "cog-reflect-weekly");
    const reflectData = JSON.parse(reflect!.action_data);
    expect(reflectData.command).toBe("/cog-reflect");
  });

  it("jobs are enabled by default", () => {
    ensureCogJobs(db);

    const jobs = db.prepare("SELECT * FROM jobs").all() as ScheduledJob[];

    for (const job of jobs) {
      expect(job.enabled).toBe(1);
    }
  });

  it("custom jobs can be inserted", () => {
    const customJob = {
      id: "morning-brief",
      cron: "0 8 * * *",
      action_type: "agent_prompt",
      action_data: JSON.stringify({ message: "Good morning!" }),
    };

    db.prepare(`
      INSERT INTO jobs (id, cron, action_type, action_data, enabled, created_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).run(customJob.id, customJob.cron, customJob.action_type, customJob.action_data);

    const jobs = db.prepare("SELECT * FROM jobs WHERE id = ?").all(customJob.id) as ScheduledJob[];
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe("morning-brief");
    expect(jobs[0].action_type).toBe("agent_prompt");
  });

  it("runs table can track job executions", () => {
    ensureCogJobs(db);

    // Simulate a job run
    db.prepare(`
      INSERT INTO runs (job_id, ran_at, success)
      VALUES (?, datetime('now'), 1)
    `).run("cog-foresight-daily");

    const runs = db.prepare("SELECT * FROM runs").all();
    expect(runs.length).toBe(1);
  });
});
