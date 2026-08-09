import { describe, expect, test } from 'bun:test'
import { makeDb } from './helpers.ts'
import { Mamoru } from '../mamoru.ts'
import { RecordingNotifier } from '../notifier.ts'
import { FakeIdle } from '../idle.ts'
import { registerAgent, sendTaskReq } from '../db.ts'
import { createPayload } from '../types.ts'

function rig() {
  const db = makeDb()
  const notifier = new RecordingNotifier()
  const m = new Mamoru({
    db, channel: 'ch', sessionId: 'claude-self', agentName: 'self',
    notifier, idle: new FakeIdle(true), config: { pollIntervalMs: 999_999 },
  })
  registerAgent(db, { session_id: 'claude-self', agent_name: 'self', description: null, provider: null, model: null, cwd: null })
  registerAgent(db, { session_id: 'peer', agent_name: 'peer', description: 'p', provider: null, model: null, cwd: null })
  // Seed peer into the roster so task_req preconditions pass.
  m.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: 'p', status: 'available', last_heartbeat: Date.now() })
  return { db, m, notifier }
}

describe('Mamoru.send — validation', () => {
  test('unknown event throws', () => {
    const { m } = rig()
    expect(() => m.send({ event: 'nope' as any, content: 'x' })).toThrow(/Unknown event/)
  })

  test.each(['ping', 'pong', 'task_ack', 'task_reject', 'task_cancel_ack'] as const)(
    'reserved event %s throws',
    event => {
      const { m } = rig()
      expect(() => m.send({ event, content: 'x', to: 'peer' })).toThrow(/reserved/i)
    },
  )

  test('word limit rejects long content', () => {
    const { m } = rig()
    const tooLong = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ')
    expect(() => m.send({ event: 'info_only', content: tooLong })).toThrow(/words/i)
  })

  test('respects config.contentWordLimit override', () => {
    const db = makeDb()
    const m = new Mamoru({ db, channel: 'ch', sessionId: 'claude-self', agentName: 'self', config: { pollIntervalMs: 999_999, contentWordLimit: 3 } })
    registerAgent(db, { session_id: 'claude-self', agent_name: 'self', description: null, provider: null, model: null, cwd: null })
    expect(() => m.send({ event: 'info_only', content: 'one two three four' })).toThrow(/≤ 3 words/)
  })
})

describe('Mamoru.send — task_req path', () => {
  test('requires "to"', () => {
    const { m } = rig()
    expect(() => m.send({ event: 'task_req', content: 'hi' })).toThrow(/"to"/)
  })

  test('rejects self-delegation', () => {
    const { m } = rig()
    expect(() => m.send({ event: 'task_req', to: 'claude-self', content: 'hi' })).toThrow(/self/)
  })

  test('rejects unknown teammate', () => {
    const { m } = rig()
    expect(() => m.send({ event: 'task_req', to: 'ghost', content: 'hi' })).toThrow(/roster/i)
  })

  test('registers outbound task + returns ids', () => {
    const { m } = rig()
    const res = m.send({ event: 'task_req', to: 'peer', content: 'do it', detail: '/tmp/x.md' })
    expect(res.taskId).toBe(res.messageId)
    expect(res.resolvedTo).toBe('peer')
    expect(m.getOutboundTasks().has(res.taskId!)).toBe(true)
  })

  test('blocking=true registers a pending retry', () => {
    const { m } = rig()
    m.send({ event: 'task_req', to: 'peer', content: 'hi', blocking: true })
    expect(m.getPendingRetries().has('peer')).toBe(true)
  })
})

describe('Mamoru.send — reply path', () => {
  test('auto-fills to/task_id from activeTask', () => {
    const { db, m } = rig()
    const incomingId = sendTaskReq(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'ch',
      payload: JSON.stringify(createPayload('task_req', 'do')),
    })
    m.pollOnce()
    expect(m.getStatus()).toBe('busy')
    const res = m.send({ event: 'task_done', content: 'ok' })
    expect(res.resolvedTo).toBe('peer')
    expect(res.taskId).toBe(incomingId)
    expect(m.getStatus()).toBe('available')
    expect(m.getActiveTask()).toBeNull()
  })

  test('throws when task-id-required event has no active task + no explicit id', () => {
    const { m } = rig()
    expect(() => m.send({ event: 'task_update', content: 'x' })).toThrow(/task_id/)
  })

  test('explicit taskId is honored even without activeTask', () => {
    const { db, m } = rig()
    const res = m.send({ event: 'task_update', to: 'peer', taskId: 42, content: 'ping' })
    expect(res.taskId).toBe(42)
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(res.messageId) as any
    expect(row.task_id).toBe(42)
  })
})

describe('Mamoru.send — outbound lastEventAt update', () => {
  test('reply touches the outbound record\'s lastEventAt', async () => {
    const { m } = rig()
    const req = m.send({ event: 'task_req', to: 'peer', content: 'go' })
    const before = m.getOutboundTasks().get(req.taskId!)!.lastEventAt
    await Bun.sleep(5)
    m.send({ event: 'task_update', to: 'peer', taskId: req.taskId!, content: 'tick' })
    const after = m.getOutboundTasks().get(req.taskId!)!.lastEventAt
    expect(after).toBeGreaterThan(before)
  })
})

describe('Mamoru.send — broadcast', () => {
  test('broadcast with no "to" writes a null to_agent row', () => {
    const { db, m } = rig()
    const res = m.send({ event: 'broadcast', content: 'hello team' })
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(res.messageId) as any
    expect(row.to_agent).toBeNull()
    expect(res.resolvedTo).toBeNull()
  })
})
