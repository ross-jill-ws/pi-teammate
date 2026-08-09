// SQLite schema for pi-teammate channels. Byte-compatible with
// pi-teammate/extensions/schema.ts (user_version = 2, same CREATE TABLE).

import { Database } from 'bun:sqlite'

/**
 * Open a channel DB with settings every Mamoru process needs: strict param
 * binding, a sane busy timeout, and foreign keys on. Callers still invoke
 * initSchema() on a fresh file.
 */
export function openChannelDb(path: string, opts: { readonly?: boolean } = {}): Database {
  const db = new Database(path, { strict: true, readonly: opts.readonly ?? false })
  // busy_timeout is a connection-level pragma; must be set per-open, not in initSchema.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function initSchema(db: Database): void {
  // bun:sqlite has no .pragma() helper; run pragmas via exec().
  db.exec('PRAGMA journal_mode = WAL')
  // Give concurrent writers a window to acquire the lock instead of throwing
  // SQLITE_BUSY immediately. Critical for the multi-agent use case.
  db.exec('PRAGMA busy_timeout = 5000')

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
  `)

  db.exec('PRAGMA user_version = 2')
}
