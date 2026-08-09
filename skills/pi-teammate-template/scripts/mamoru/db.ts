// DB helpers. Mirrors pi-teammate/extensions/db.ts verbatim.
// Keep SQL and behaviour in lockstep so the two codebases stay wire-compatible
// over the shared team.db.

import type { Database } from 'bun:sqlite'
import type { AgentRow, AgentStatus, MessageRow } from './types.ts'
import { MAX_CONTENT_WORDS, countWords } from './types.ts'

// ── Agents ─────────────────────────────────────────────────────────

export function registerAgent(
  db: Database,
  agent: Omit<AgentRow, 'status' | 'last_heartbeat'> & { status?: AgentStatus },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO agents (session_id, agent_name, description, provider, model, cwd, status, last_heartbeat)
    VALUES (@session_id, @agent_name, @description, @provider, @model, @cwd, @status, @last_heartbeat)
  `).run({
    session_id: agent.session_id,
    agent_name: agent.agent_name,
    description: agent.description ?? null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    cwd: agent.cwd ?? null,
    status: agent.status ?? 'available',
    last_heartbeat: Date.now(),
  })
}

export function updateAgentStatus(db: Database, sessionId: string, status: AgentStatus): void {
  db.prepare('UPDATE agents SET status = ? WHERE session_id = ?').run(status, sessionId)
}

export function updateHeartbeat(db: Database, sessionId: string): void {
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE session_id = ?').run(Date.now(), sessionId)
}

export function getActiveAgents(db: Database): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE status != 'inactive'").all() as AgentRow[]
}

export function getAgentBySession(db: Database, sessionId: string): AgentRow | null {
  return (db.prepare('SELECT * FROM agents WHERE session_id = ?').get(sessionId) as AgentRow) ?? null
}

export function getAgentByName(db: Database, name: string): AgentRow | null {
  return (db.prepare('SELECT * FROM agents WHERE agent_name = ?').get(name) as AgentRow) ?? null
}

export function getInactiveAgentsByName(
  db: Database,
  name: string,
  excludeSessionId?: string,
): AgentRow[] {
  if (excludeSessionId) {
    return db.prepare(`
      SELECT * FROM agents
      WHERE agent_name = ?
        AND status = 'inactive'
        AND session_id != ?
      ORDER BY COALESCE(last_heartbeat, 0) ASC, session_id ASC
    `).all(name, excludeSessionId) as AgentRow[]
  }
  return db.prepare(`
    SELECT * FROM agents
    WHERE agent_name = ?
      AND status = 'inactive'
    ORDER BY COALESCE(last_heartbeat, 0) ASC, session_id ASC
  `).all(name) as AgentRow[]
}

export function deleteAgent(db: Database, sessionId: string): void {
  // bun:sqlite has no .pragma() helper; read/toggle via query() + exec().
  const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | null
  const foreignKeysEnabled = !!fkRow?.foreign_keys
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.prepare('DELETE FROM agent_cursors WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM agents WHERE session_id = ?').run(sessionId)
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON')
  }
}

// ── Messages ───────────────────────────────────────────────────────

export function sendMessage(
  db: Database,
  msg: {
    from_agent: string
    to_agent: string | null
    channel: string
    task_id: number | null
    ref_message_id: number | null
    payload: string
    maxContentWords?: number
  },
): number {
  let parsed: any
  try {
    parsed = JSON.parse(msg.payload)
  } catch {
    throw new Error('payload must be valid JSON')
  }
  if (typeof parsed.content !== 'string') {
    throw new Error('payload must have a content field')
  }
  const limit = msg.maxContentWords ?? MAX_CONTENT_WORDS
  if (countWords(parsed.content) > limit) {
    throw new Error(
      `payload.content must be ≤ ${limit} words (got ${countWords(parsed.content)}). Put details in the 'detail' field.`,
    )
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
  })
  return Number(result.lastInsertRowid)
}

export function sendTaskReq(
  db: Database,
  msg: {
    from_agent: string
    to_agent: string | null
    channel: string
    payload: string
    maxContentWords?: number
  },
): number {
  const messageId = sendMessage(db, {
    from_agent: msg.from_agent,
    to_agent: msg.to_agent,
    channel: msg.channel,
    task_id: null,
    ref_message_id: null,
    payload: msg.payload,
    maxContentWords: msg.maxContentWords,
  })
  db.prepare('UPDATE messages SET task_id = ? WHERE message_id = ?').run(messageId, messageId)
  return messageId
}

// ── Cursors ────────────────────────────────────────────────────────

export function initCursor(db: Database, sessionId: string, channel: string): void {
  // Skip past existing messages so a new session doesn't replay history.
  // ON CONFLICT DO NOTHING preserves any existing cursor (reconnect case).
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(message_id), 0) AS max_id FROM messages WHERE channel = ?')
    .get(channel) as { max_id: number }

  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(sessionId, channel, maxRow.max_id)
}

export function advanceCursor(
  db: Database,
  sessionId: string,
  channel: string,
  lastReadId: number,
): void {
  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, channel) DO UPDATE SET last_read_id = excluded.last_read_id
  `).run(sessionId, channel, lastReadId)
}

export function getCursor(
  db: Database,
  sessionId: string,
  channel: string,
): number {
  const row = db
    .prepare('SELECT last_read_id FROM agent_cursors WHERE session_id = ? AND channel = ?')
    .get(sessionId, channel) as { last_read_id: number } | undefined
  return row?.last_read_id ?? 0
}

export function getUnreadMessages(
  db: Database,
  sessionId: string,
  channel: string,
): MessageRow[] {
  const lastReadId = getCursor(db, sessionId, channel)
  return db.prepare(`
    SELECT * FROM messages
    WHERE channel = ?
      AND message_id > ?
      AND from_agent != ?
      AND (to_agent IS NULL OR to_agent = ?)
    ORDER BY message_id ASC
  `).all(channel, lastReadId, sessionId, sessionId) as MessageRow[]
}

export function getMessagesByTaskId(db: Database, taskId: number): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY message_id ASC')
    .all(taskId) as MessageRow[]
}
