/**
 * Database helper functions for pi-teammate.
 * All functions take `db: Database` as first argument (dependency injection).
 */
import type Database from "better-sqlite3";
import type { AgentRow, AgentStatus, MessageRow } from "./types.ts";
import { MAX_CONTENT_WORDS, countWords } from "./types.ts";

// ── Agent Functions ─────────────────────────────────────────────

export function registerAgent(
  db: Database.Database,
  agent: Omit<AgentRow, "status" | "last_heartbeat"> & { status?: AgentStatus },
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents (session_id, agent_name, description, provider, model, cwd, status, last_heartbeat)
    VALUES (@session_id, @agent_name, @description, @provider, @model, @cwd, @status, @last_heartbeat)
  `);
  stmt.run({
    session_id: agent.session_id,
    agent_name: agent.agent_name,
    description: agent.description ?? null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    cwd: agent.cwd ?? null,
    status: agent.status ?? "available",
    last_heartbeat: Date.now(),
  });
}

export function updateAgentStatus(
  db: Database.Database,
  sessionId: string,
  status: AgentStatus,
): void {
  db.prepare("UPDATE agents SET status = ? WHERE session_id = ?").run(status, sessionId);
}

export function updateHeartbeat(db: Database.Database, sessionId: string): void {
  db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = ?").run(Date.now(), sessionId);
}

export function getActiveAgents(db: Database.Database): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE status != 'inactive'").all() as AgentRow[];
}

export function getAgentBySession(db: Database.Database, sessionId: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE session_id = ?").get(sessionId) as AgentRow) ?? null;
}

export function getAgentByName(db: Database.Database, name: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE agent_name = ?").get(name) as AgentRow) ?? null;
}

// ── Message Functions ───────────────────────────────────────────

export function sendMessage(
  db: Database.Database,
  msg: {
    from_agent: string;
    to_agent: string | null;
    channel: string;
    task_id: number | null;
    ref_message_id: number | null;
    payload: string;
    maxContentWords?: number;
  },
): number {
  // Validate payload JSON has content field within word limit
  let parsed: any;
  try {
    parsed = JSON.parse(msg.payload);
  } catch {
    throw new Error("payload must be valid JSON");
  }
  if (typeof parsed.content !== "string") {
    throw new Error("payload must have a content field");
  }
  const limit = msg.maxContentWords ?? MAX_CONTENT_WORDS;
  if (countWords(parsed.content) > limit) {
    throw new Error(`payload.content must be ≤ ${limit} words (got ${countWords(parsed.content)}). Put details in the 'detail' field.`);
  }

  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, channel, task_id, ref_message_id, payload, created_at)
    VALUES (@from_agent, @to_agent, @channel, @task_id, @ref_message_id, @payload, @created_at)
  `).run({
    from_agent: msg.from_agent,
    to_agent: msg.to_agent,
    channel: msg.channel,
    task_id: msg.task_id,
    ref_message_id: msg.ref_message_id,
    payload: msg.payload,
    created_at: Date.now(),
  });

  return Number(result.lastInsertRowid);
}

export function sendTaskReq(
  db: Database.Database,
  msg: {
    from_agent: string;
    to_agent: string | null;
    channel: string;
    payload: string;
    maxContentWords?: number;
  },
): number {
  // Insert with task_id = NULL first
  const messageId = sendMessage(db, {
    from_agent: msg.from_agent,
    to_agent: msg.to_agent,
    channel: msg.channel,
    task_id: null,
    ref_message_id: null,
    payload: msg.payload,
    maxContentWords: msg.maxContentWords,
  });

  // Then update task_id = message_id (self-referencing)
  db.prepare("UPDATE messages SET task_id = ? WHERE message_id = ?").run(messageId, messageId);

  return messageId;
}

// ── Cursor Functions ────────────────────────────────────────────

export function initCursor(db: Database.Database, sessionId: string, channel: string): void {
  // Skip to current max message_id so we don't replay old messages from before this session.
  // If the cursor already exists (e.g., reconnect with same session_id), keep the existing position.
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(message_id), 0) AS max_id FROM messages WHERE channel = ?"
  ).get(channel) as { max_id: number };

  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(sessionId, channel, maxRow.max_id);
}

export function advanceCursor(
  db: Database.Database,
  sessionId: string,
  channel: string,
  lastReadId: number,
): void {
  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, channel) DO UPDATE SET last_read_id = excluded.last_read_id
  `).run(sessionId, channel, lastReadId);
}

export function getUnreadMessages(
  db: Database.Database,
  sessionId: string,
  channel: string,
): MessageRow[] {
  // Get the cursor position
  const cursor = db.prepare(
    "SELECT last_read_id FROM agent_cursors WHERE session_id = ? AND channel = ?",
  ).get(sessionId, channel) as { last_read_id: number } | undefined;

  const lastReadId = cursor?.last_read_id ?? 0;

  return db.prepare(`
    SELECT * FROM messages
    WHERE channel = ?
      AND message_id > ?
      AND from_agent != ?
      AND (to_agent IS NULL OR to_agent = ?)
    ORDER BY message_id ASC
  `).all(channel, lastReadId, sessionId, sessionId) as MessageRow[];
}

export function getMessagesByTaskId(db: Database.Database, taskId: number): MessageRow[] {
  return db.prepare(
    "SELECT * FROM messages WHERE task_id = ? ORDER BY message_id ASC",
  ).all(taskId) as MessageRow[];
}
