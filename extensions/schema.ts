/**
 * SQLite schema initialization for pi-teammate.
 */
import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      description TEXT,
      provider TEXT,
      model TEXT,
      cwd TEXT,
      status TEXT DEFAULT 'available' CHECK (status IN ('available', 'busy', 'inactive')),
      last_heartbeat INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      channel TEXT NOT NULL,
      task_id INTEGER,
      ref_message_id INTEGER,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_agent) REFERENCES agents(session_id),
      FOREIGN KEY (task_id) REFERENCES messages(message_id),
      FOREIGN KEY (ref_message_id) REFERENCES messages(message_id)
    );

    CREATE TABLE IF NOT EXISTS agent_cursors (
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_id INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, channel),
      FOREIGN KEY (session_id) REFERENCES agents(session_id)
    );
  `);

  db.pragma("user_version = 2");
}
