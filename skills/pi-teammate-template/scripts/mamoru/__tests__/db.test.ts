import { describe, expect, test, beforeEach } from 'bun:test'
import type Database from 'better-sqlite3'
import { makeDb } from './helpers.ts'
import {
  advanceCursor,
  deleteAgent,
  getActiveAgents,
  getAgentByName,
  getAgentBySession,
  getCursor,
  getInactiveAgentsByName,
  getMessagesByTaskId,
  getUnreadMessages,
  initCursor,
  registerAgent,
  sendMessage,
  sendTaskReq,
  updateAgentStatus,
  updateHeartbeat,
} from '../db.ts'
import { createPayload } from '../types.ts'

let db: Database.Database
beforeEach(() => { db = makeDb() })

function seedAgent(id: string, name = id, status: 'available' | 'busy' | 'inactive' = 'available') {
  registerAgent(db, {
    session_id: id, agent_name: name, description: `desc-${name}`,
    provider: null, model: null, cwd: null, status,
  })
}

function payload(content: string): string {
  return JSON.stringify(createPayload('broadcast', content))
}

// ── Agents ──────────────────────────────────────────────────────────────

describe('registerAgent', () => {
  test('inserts new agent with defaults', () => {
    registerAgent(db, {
      session_id: 'a', agent_name: 'alice', description: null,
      provider: null, model: null, cwd: null,
    })
    const row = getAgentBySession(db, 'a')!
    expect(row.agent_name).toBe('alice')
    expect(row.status).toBe('available')
    expect(row.last_heartbeat).toBeGreaterThan(0)
  })
  test('REPLACE upserts existing session_id', () => {
    seedAgent('a', 'alice')
    registerAgent(db, {
      session_id: 'a', agent_name: 'alice2', description: 'new',
      provider: null, model: null, cwd: null, status: 'busy',
    })
    const row = getAgentBySession(db, 'a')!
    expect(row.agent_name).toBe('alice2')
    expect(row.status).toBe('busy')
  })
})

describe('updateAgentStatus', () => {
  test('flips status', () => {
    seedAgent('a')
    updateAgentStatus(db, 'a', 'busy')
    expect(getAgentBySession(db, 'a')!.status).toBe('busy')
    updateAgentStatus(db, 'a', 'inactive')
    expect(getAgentBySession(db, 'a')!.status).toBe('inactive')
  })
  test('no-op when session_id missing, no throw', () => {
    expect(() => updateAgentStatus(db, 'nope', 'busy')).not.toThrow()
  })
})

describe('updateHeartbeat', () => {
  test('moves heartbeat forward', async () => {
    seedAgent('a')
    const before = getAgentBySession(db, 'a')!.last_heartbeat!
    await new Promise(r => setTimeout(r, 5))
    updateHeartbeat(db, 'a')
    const after = getAgentBySession(db, 'a')!.last_heartbeat!
    expect(after).toBeGreaterThanOrEqual(before)
  })
})

describe('getActiveAgents', () => {
  test('excludes inactive', () => {
    seedAgent('a')
    seedAgent('b', 'bob', 'inactive')
    seedAgent('c', 'carol', 'busy')
    const ids = getActiveAgents(db).map(r => r.session_id).sort()
    expect(ids).toEqual(['a', 'c'])
  })
})

describe('getAgentBySession / getAgentByName', () => {
  test('hit + miss', () => {
    seedAgent('a', 'alice')
    expect(getAgentBySession(db, 'a')?.agent_name).toBe('alice')
    expect(getAgentBySession(db, 'nope')).toBeNull()
    expect(getAgentByName(db, 'alice')?.session_id).toBe('a')
    expect(getAgentByName(db, 'nope')).toBeNull()
  })
})

describe('getInactiveAgentsByName', () => {
  test('returns only inactive, sorted by heartbeat asc', () => {
    seedAgent('a1', 'alice')
    seedAgent('a2', 'alice', 'inactive')
    seedAgent('a3', 'alice', 'inactive')
    // force distinct heartbeats
    db.prepare('UPDATE agents SET last_heartbeat = 100 WHERE session_id = ?').run('a2')
    db.prepare('UPDATE agents SET last_heartbeat = 200 WHERE session_id = ?').run('a3')
    const rows = getInactiveAgentsByName(db, 'alice')
    expect(rows.map(r => r.session_id)).toEqual(['a2', 'a3'])
  })
  test('respects excludeSessionId', () => {
    seedAgent('a1', 'alice', 'inactive')
    seedAgent('a2', 'alice', 'inactive')
    const rows = getInactiveAgentsByName(db, 'alice', 'a1')
    expect(rows.map(r => r.session_id)).toEqual(['a2'])
  })
})

describe('deleteAgent', () => {
  test('removes agent and its cursor rows', () => {
    seedAgent('a')
    initCursor(db, 'a', 'ch')
    deleteAgent(db, 'a')
    expect(getAgentBySession(db, 'a')).toBeNull()
    expect(getCursor(db, 'a', 'ch')).toBe(0)
  })
})

// ── Messages ────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  beforeEach(() => seedAgent('a'))

  test('inserts row and returns autoincrement id', () => {
    const id = sendMessage(db, {
      from_agent: 'a', to_agent: null, channel: 'ch',
      task_id: null, ref_message_id: null, payload: payload('hi'),
    })
    expect(id).toBeGreaterThan(0)
  })

  test('throws on malformed JSON payload', () => {
    expect(() => sendMessage(db, {
      from_agent: 'a', to_agent: null, channel: 'ch',
      task_id: null, ref_message_id: null, payload: '{not json',
    })).toThrow(/valid JSON/)
  })

  test('throws when content field missing', () => {
    expect(() => sendMessage(db, {
      from_agent: 'a', to_agent: null, channel: 'ch',
      task_id: null, ref_message_id: null, payload: JSON.stringify({ event: 'broadcast' }),
    })).toThrow(/content field/)
  })

  test('throws when content exceeds default 20-word limit', () => {
    const long = Array(25).fill('word').join(' ')
    expect(() => sendMessage(db, {
      from_agent: 'a', to_agent: null, channel: 'ch',
      task_id: null, ref_message_id: null, payload: payload(long),
    })).toThrow(/≤ 20 words/)
  })

  test('honours custom maxContentWords limit', () => {
    const text = 'one two three'
    expect(() => sendMessage(db, {
      from_agent: 'a', to_agent: null, channel: 'ch',
      task_id: null, ref_message_id: null, payload: payload(text), maxContentWords: 2,
    })).toThrow(/≤ 2 words/)
  })
})

describe('sendTaskReq', () => {
  test('task_id equals message_id (self-reference)', () => {
    seedAgent('a'); seedAgent('b')
    const id = sendTaskReq(db, {
      from_agent: 'a', to_agent: 'b', channel: 'ch',
      payload: JSON.stringify(createPayload('task_req', 'go')),
    })
    const row = db.prepare('SELECT task_id FROM messages WHERE message_id = ?').get(id) as { task_id: number }
    expect(row.task_id).toBe(id)
  })
})

// ── Cursors ─────────────────────────────────────────────────────────────

describe('initCursor', () => {
  test('empty channel: cursor = 0', () => {
    seedAgent('a')
    initCursor(db, 'a', 'ch')
    expect(getCursor(db, 'a', 'ch')).toBe(0)
  })

  test('populated channel: cursor skips to MAX(message_id)', () => {
    seedAgent('a'); seedAgent('b')
    sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('1') })
    const id2 = sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('2') })
    initCursor(db, 'b', 'ch')
    expect(getCursor(db, 'b', 'ch')).toBe(id2)
  })

  test('second call does not rewind', () => {
    seedAgent('a')
    initCursor(db, 'a', 'ch')
    advanceCursor(db, 'a', 'ch', 42)
    initCursor(db, 'a', 'ch') // should be no-op via ON CONFLICT DO NOTHING
    expect(getCursor(db, 'a', 'ch')).toBe(42)
  })
})

describe('advanceCursor', () => {
  test('upserts cursor forward', () => {
    seedAgent('a')
    advanceCursor(db, 'a', 'ch', 5)
    expect(getCursor(db, 'a', 'ch')).toBe(5)
    advanceCursor(db, 'a', 'ch', 10)
    expect(getCursor(db, 'a', 'ch')).toBe(10)
  })
})

describe('getUnreadMessages', () => {
  test('returns strictly after cursor, excluding self, including broadcasts', () => {
    seedAgent('a'); seedAgent('b')
    // broadcast from a (b sees it), direct a→b (b sees), direct a→someone-else (b doesn't see)
    const m1 = sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('bcast') })
    const m2 = sendMessage(db, { from_agent: 'a', to_agent: 'b', channel: 'ch', task_id: null, ref_message_id: null, payload: payload('to-b') })
    sendMessage(db, { from_agent: 'a', to_agent: 'c', channel: 'ch', task_id: null, ref_message_id: null, payload: payload('to-c') })
    // self-sent from b — must not appear
    sendMessage(db, { from_agent: 'b', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('self') })

    initCursor(db, 'b', 'ch'); advanceCursor(db, 'b', 'ch', 0)
    const ids = getUnreadMessages(db, 'b', 'ch').map(m => m.message_id)
    expect(ids).toEqual([m1, m2])
  })

  test('respects cursor advance', () => {
    seedAgent('a'); seedAgent('b')
    const m1 = sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('1') })
    const m2 = sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'ch', task_id: null, ref_message_id: null, payload: payload('2') })
    advanceCursor(db, 'b', 'ch', m1)
    expect(getUnreadMessages(db, 'b', 'ch').map(m => m.message_id)).toEqual([m2])
  })

  test('only returns messages on matching channel', () => {
    seedAgent('a'); seedAgent('b')
    sendMessage(db, { from_agent: 'a', to_agent: null, channel: 'other', task_id: null, ref_message_id: null, payload: payload('x') })
    expect(getUnreadMessages(db, 'b', 'ch')).toEqual([])
  })
})

describe('getMessagesByTaskId', () => {
  test('returns full task thread in insertion order', () => {
    seedAgent('a'); seedAgent('b')
    const taskId = sendTaskReq(db, { from_agent: 'a', to_agent: 'b', channel: 'ch', payload: JSON.stringify(createPayload('task_req', 'go')) })
    sendMessage(db, { from_agent: 'b', to_agent: 'a', channel: 'ch', task_id: taskId, ref_message_id: taskId, payload: JSON.stringify(createPayload('task_ack', 'ok')) })
    sendMessage(db, { from_agent: 'b', to_agent: 'a', channel: 'ch', task_id: taskId, ref_message_id: taskId, payload: JSON.stringify(createPayload('task_done', 'done')) })
    const events = getMessagesByTaskId(db, taskId).map(m => JSON.parse(m.payload).event)
    expect(events).toEqual(['task_req', 'task_ack', 'task_done'])
  })
})
