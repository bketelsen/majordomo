/**
 * Database Schema Migration Utility
 *
 * Provides a simplified, maintainable approach to database schema evolution
 * using a schema_version table instead of multiple try-catch blocks.
 */

import { Database } from "bun:sqlite";
import { createLogger } from "./logger.ts";

const logger = createLogger({ context: { component: "db-migrations" } });

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

/**
 * Initialize the schema_version table and run pending migrations.
 * 
 * @param db - SQLite database instance
 * @param migrations - Array of migrations to apply (must be ordered by version)
 */
export function runMigrations(db: Database, migrations: Migration[]): void {
  // Create schema_version table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get current schema version
  const currentVersion = (db.prepare(
    "SELECT COALESCE(MAX(version), 0) as version FROM schema_version"
  ).get() as { version: number }).version;

  logger.debug("Database schema version", { currentVersion });

  // Apply pending migrations
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);
  
  if (pendingMigrations.length === 0) {
    logger.debug("No pending migrations");
    return;
  }

  logger.info("Applying database migrations", { 
    currentVersion, 
    targetVersion: Math.max(...pendingMigrations.map(m => m.version)),
    count: pendingMigrations.length 
  });

  for (const migration of pendingMigrations) {
    try {
      logger.info("Applying migration", { version: migration.version, name: migration.name });
      
      // Run migration in a transaction
      db.exec("BEGIN TRANSACTION");
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name
      );
      db.exec("COMMIT");
      
      logger.info("Migration applied successfully", { version: migration.version, name: migration.name });
    } catch (err) {
      db.exec("ROLLBACK");
      logger.error("Migration failed", { version: migration.version, name: migration.name, error: err });
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err}`);
    }
  }
}
