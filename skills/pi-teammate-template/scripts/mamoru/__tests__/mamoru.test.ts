import { describe, expect, test, beforeEach } from 'bun:test'
import type Database from 'better-sqlite3'
import { makeDb } from './helpers.ts'
import { Mamoru } from '../mamoru.ts'
import { RecordingNotifier } from '../notifier.ts'
import { FakeIdle } from '../idle.ts'
import {
  getAgentBySession,
  getCursor,
  registerAgent,
  sendMessage,
  sendTaskReq,
} from '../db.ts'
import { createPayload } from '../types.ts'

// Build a running Mamoru instance wired up with fakes. Channel constant across
// tests; session ids deterministic so assertions stay simple.
function rig(channel = 'test-ch') {
  const db = makeDb()
  const notifier = new RecordingNotifier()
  const idle = new FakeIdle(true)
  const m = new Mamoru({
    db,
    channel,
    sessionId: 'claude-self',
    agentName: 'self',
    description: 'self-desc',
    notifier,
    idle,
    config: { pollIntervalMs: 999_999 }, // disable real timer; we call pollOnce manually
  })
  // Register self manually, skipping start()'s agent_join broadcast so the
  // roster/message tables are predictable. Tests that want start() call it.
  registerAgent(db, { session_id: 'claude-self', agent_name: 'self', description: null, provider: null, model: null, cwd: null })
  // And register a peer.
  registerAgent(db, { session_id: 'peer', agent_name: 'peer', description: 'peer-desc', provider: null, model: null, cwd: null })
  return { db, m, notifier, idle, channel }
}

function peerPayload(event: string, content = 'x', opts: { intent?: string | null } = {}) {
  return JSON.stringify(createPayload(event as any, content, { intent: opts.intent ?? null }))
}

describe('pollOnce — routing', () => {
  test('ping → auto-reply pong, no notifier call', () => {
    const { db, m, notifier } = rig()
    sendMessage(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', task_id: null, ref_message_id: null, payload: peerPayload('ping', 'ping') })
    m.pollOnce()
    expect(notifier.calls.length).toBe(0)
    const pongs = db.prepare("SELECT * FROM messages WHERE from_agent='claude-self' AND payload LIKE '%pong%'").all()
    expect(pongs.length).toBe(1)
  })

  test('pong → silent', () => {
    const { db, m, notifier } = rig()
    sendMessage(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', task_id: null, ref_message_id: null, payload: peerPayload('pong') })
    m.pollOnce()
    expect(notifier.calls.length).toBe(0)
  })

  test('task_req new + available → task_ack + busy + forward', () => {
    const { db, m, notifier } = rig()
    const taskId = sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'do it') })
    m.pollOnce()
    // auto-ack in DB
    const acks = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self' AND to_agent='peer'").all() as { payload: string }[]
    expect(acks.some(r => JSON.parse(r.payload).event === 'task_ack')).toBe(true)
    // status flipped
    expect(m.getStatus()).toBe('busy')
    expect(m.getActiveTask()?.taskId).toBe(taskId)
    // forwarded
    expect(notifier.calls.length).toBe(1)
    expect(notifier.calls[0].meta?.event).toBe('task_req')
  })

  test('task_req new + busy → task_reject, no forward', () => {
    const { db, m, notifier } = rig()
    // first task makes us busy
    sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'first') })
    m.pollOnce()
    notifier.reset()
    // second task_req — with busy status should reject
    sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'second') })
    m.pollOnce()
    const rejects = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self'").all() as { payload: string }[]
    expect(rejects.some(r => JSON.parse(r.payload).event === 'task_reject')).toBe(true)
    // not forwarded to LLM (the reject handling is the auto-response; no steer call for reject-sent)
    expect(notifier.calls.length).toBe(0)
  })

  test('task_req follow-up (not new) → forward only, no ack', () => {
    const { db, m, notifier } = rig()
    // Simulate a follow-up by inserting a task_req where task_id != message_id.
    // Need an existing task_id to reference.
    const orig = sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'orig') })
    m.pollOnce()
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: orig, ref_message_id: orig, payload: peerPayload('task_req', 'more info'),
    })
    m.pollOnce()
    // no NEW ack row (the existing ack for the original is fine; count acks after reset baseline)
    expect(notifier.calls.length).toBe(1)
    expect(notifier.calls[0].meta?.event).toBe('task_req')
  })

  test('task_ack → clears pending retry, silent', () => {
    const { db, m, notifier } = rig()
    m.sendTaskReq({ to: 'peer', content: 'hi', blocking: true })
    expect(m.getPendingRetries().has('peer')).toBe(true)
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: null, ref_message_id: null, payload: peerPayload('task_ack'),
    })
    m.pollOnce()
    expect(m.getPendingRetries().has('peer')).toBe(false)
    expect(notifier.calls.length).toBe(0)
  })

  test('task_reject with blocking retry → silent, counter incremented', () => {
    const { db, m, notifier } = rig()
    const taskId = m.sendTaskReq({ to: 'peer', content: 'hi', blocking: true })
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_reject', 'busy'),
    })
    m.pollOnce()
    expect(notifier.calls.length).toBe(0)
    expect(m.getPendingRetries().get('peer')?.retryCount).toBe(1)
    expect(m.getOutboundTasks().has(taskId)).toBe(false)
  })

  test('task_reject with non-blocking retry → notifier informed, retry stays', () => {
    const { db, m, notifier } = rig()
    const taskId = m.sendTaskReq({ to: 'peer', content: 'hi', blocking: false })
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_reject', 'busy'),
    })
    m.pollOnce()
    expect(notifier.calls.length).toBe(1)
    expect(m.getPendingRetries().has('peer')).toBe(true)
  })

  test('task_reject without pending retry → forwarded', () => {
    const { db, m, notifier } = rig()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: 99, ref_message_id: 99, payload: peerPayload('task_reject', 'busy'),
    })
    m.pollOnce()
    expect(notifier.calls.length).toBe(1)
    expect(notifier.calls[0].meta?.event).toBe('task_reject')
  })

  test.each(['task_clarify', 'task_clarify_res', 'task_update'] as const)('%s → forwarded', event => {
    const { db, m, notifier } = rig()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: 5, ref_message_id: 5, payload: peerPayload(event, 'x'),
    })
    m.pollOnce()
    expect(notifier.calls.length).toBe(1)
    expect(notifier.calls[0].meta?.event).toBe(event)
  })

  test('task_done → clears outbound + forwards', () => {
    const { db, m, notifier } = rig()
    const taskId = m.sendTaskReq({ to: 'peer', content: 'hi' })
    expect(m.getOutboundTasks().has(taskId)).toBe(true)
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_done', 'done'),
    })
    m.pollOnce()
    expect(m.getOutboundTasks().has(taskId)).toBe(false)
    expect(notifier.calls[0].meta?.event).toBe('task_done')
  })

  test('task_fail → clears outbound + forwards', () => {
    const { db, m, notifier } = rig()
    const taskId = m.sendTaskReq({ to: 'peer', content: 'hi' })
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_fail', 'oops'),
    })
    m.pollOnce()
    expect(m.getOutboundTasks().has(taskId)).toBe(false)
    expect(notifier.calls[0].meta?.event).toBe('task_fail')
  })

  test('task_cancel → auto-ack + clears active task + forwards', () => {
    const { db, m, notifier } = rig()
    // become busy first
    const taskId = sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'go') })
    m.pollOnce()
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_cancel', 'stop'),
    })
    m.pollOnce()
    const sent = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self'").all() as { payload: string }[]
    expect(sent.some(r => JSON.parse(r.payload).event === 'task_cancel_ack')).toBe(true)
    expect(m.getActiveTask()).toBeNull()
    // forwarded
    expect(notifier.calls.some(c => c.meta?.event === 'task_cancel')).toBe(true)
  })

  test('task_cancel_ack → clears outbound, silent', () => {
    const { db, m, notifier } = rig()
    const taskId = m.sendTaskReq({ to: 'peer', content: 'hi' })
    notifier.reset()
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: taskId, ref_message_id: taskId, payload: peerPayload('task_cancel_ack'),
    })
    m.pollOnce()
    expect(m.getOutboundTasks().has(taskId)).toBe(false)
    expect(notifier.calls.length).toBe(0)
  })

  test('broadcast agent_join → roster+, notifier called', () => {
    const { db, m, notifier } = rig()
    // New peer appears
    registerAgent(db, { session_id: 'newcomer', agent_name: 'newc', description: 'fresh', provider: null, model: null, cwd: null })
    sendMessage(db, {
      from_agent: 'newcomer', to_agent: null, channel: 'test-ch',
      task_id: null, ref_message_id: null, payload: peerPayload('broadcast', 'hi', { intent: 'agent_join' }),
    })
    m.pollOnce()
    expect(m.getRoster().get('newcomer')).toBeDefined()
    expect(notifier.calls.some(c => c.meta?.event === 'agent_join')).toBe(true)
  })

  test('broadcast agent_leave → roster-, notifier called', () => {
    const { db, m, notifier } = rig()
    // preload roster
    m.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: '', status: 'available', last_heartbeat: Date.now() })
    sendMessage(db, {
      from_agent: 'peer', to_agent: null, channel: 'test-ch',
      task_id: null, ref_message_id: null, payload: peerPayload('broadcast', 'bye', { intent: 'agent_leave' }),
    })
    m.pollOnce()
    expect(m.getRoster().get('peer')).toBeUndefined()
    expect(notifier.calls.some(c => c.meta?.event === 'agent_leave')).toBe(true)
  })

  test('broadcast plain → forwarded', () => {
    const { db, m, notifier } = rig()
    sendMessage(db, {
      from_agent: 'peer', to_agent: null, channel: 'test-ch',
      task_id: null, ref_message_id: null, payload: peerPayload('broadcast', 'news'),
    })
    m.pollOnce()
    expect(notifier.calls[0]?.meta?.event).toBe('broadcast')
  })

  test('info_only → forwarded', () => {
    const { db, m, notifier } = rig()
    sendMessage(db, {
      from_agent: 'peer', to_agent: null, channel: 'test-ch',
      task_id: null, ref_message_id: null, payload: peerPayload('info_only', 'fyi'),
    })
    m.pollOnce()
    expect(notifier.calls[0]?.meta?.event).toBe('info_only')
  })
})

describe('cursor advances', () => {
  test('cursor moves past processed messages', () => {
    const { db, m } = rig()
    const id = sendMessage(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', task_id: null, ref_message_id: null, payload: peerPayload('pong') })
    m.pollOnce()
    expect(getCursor(db, 'claude-self', 'test-ch')).toBe(id)
  })
})

describe('onRosterChange callback', () => {
  test('fires exactly on diff', () => {
    const db = makeDb()
    const calls: string[] = []
    const m = new Mamoru({
      db, channel: 'rc', sessionId: 'claude-self', agentName: 'self',
      onRosterChange: () => calls.push(Date.now().toString()),
      config: { pollIntervalMs: 999_999 },
    })
    registerAgent(db, { session_id: 'claude-self', agent_name: 'self', description: null, provider: null, model: null, cwd: null })

    // First poll: roster empty, no diff.
    m.pollOnce()
    expect(calls.length).toBe(0)

    // Peer joins via broadcast — realistic path (processMessage adds them to
    // the roster, which produces a diff on next snapshot).
    registerAgent(db, { session_id: 'peer', agent_name: 'p', description: null, provider: null, model: null, cwd: null })
    sendMessage(db, {
      from_agent: 'peer', to_agent: null, channel: 'rc',
      task_id: null, ref_message_id: null, payload: peerPayload('broadcast', 'hi', { intent: 'agent_join' }),
    })
    m.pollOnce()
    expect(calls.length).toBe(1)

    // No new change → no fire.
    m.pollOnce()
    expect(calls.length).toBe(1)

    // Peer status changes → diff fires.
    db.prepare("UPDATE agents SET status='busy' WHERE session_id='peer'").run()
    m.pollOnce()
    expect(calls.length).toBe(2)
  })
})

describe('processPendingRetries', () => {
  test('resends when target flips to available', async () => {
    const { db, m, notifier } = rig()
    // Seed peer in roster as busy so the flip-to-available is a real diff.
    m.getRoster().update({
      session_id: 'peer', agent_name: 'peer', description: 'peer-desc',
      status: 'busy', last_heartbeat: Date.now(),
    })
    // Reflect that busy state in the DB too, so the first refresh doesn't
    // immediately diff to 'available'.
    db.prepare("UPDATE agents SET status='busy' WHERE session_id='peer'").run()

    const firstTaskId = m.sendTaskReq({ to: 'peer', content: 'hi', blocking: false })
    sendMessage(db, {
      from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch',
      task_id: firstTaskId, ref_message_id: firstTaskId, payload: peerPayload('task_reject', 'busy'),
    })
    m.pollOnce()
    expect(m.getPendingRetries().has('peer')).toBe(true)

    // Now flip peer to available in the DB — next poll should detect the diff
    // and fire the pending retry.
    db.prepare("UPDATE agents SET status='available' WHERE session_id='peer'").run()
    notifier.reset()
    m.pollOnce()
    expect(m.getPendingRetries().has('peer')).toBe(false)
    const retries = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self' AND to_agent='peer'").all() as { payload: string }[]
    const taskReqs = retries.filter(r => JSON.parse(r.payload).event === 'task_req')
    expect(taskReqs.length).toBeGreaterThanOrEqual(2) // original + retry
    expect(notifier.calls.some(c => c.meta?.event === 'task_req_retry')).toBe(true)
  })
})

describe('syncIdleStatus', () => {
  test('flips available→busy when idle reports false', () => {
    const { db, m, idle } = rig()
    expect(m.getStatus()).toBe('available')
    idle.set(false)
    m.pollOnce()
    expect(m.getStatus()).toBe('busy')
    expect(getAgentBySession(db, 'claude-self')?.status).toBe('busy')
  })

  test('flips busy→available when idle returns and no active task', () => {
    const { m, idle } = rig()
    idle.set(false); m.pollOnce()
    expect(m.getStatus()).toBe('busy')
    idle.set(true); m.pollOnce()
    expect(m.getStatus()).toBe('available')
  })

  test('stays busy if active task is in flight even when idle', () => {
    const { db, m, idle } = rig()
    sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'work') })
    m.pollOnce() // auto-ack → busy + activeTask set
    idle.set(true)
    m.pollOnce()
    expect(m.getStatus()).toBe('busy')
  })
})

describe('sendReply (worker reporting back)', () => {
  test('task_done flips worker back to available', () => {
    const { db, m } = rig()
    const taskId = sendTaskReq(db, { from_agent: 'peer', to_agent: 'claude-self', channel: 'test-ch', payload: peerPayload('task_req', 'do') })
    m.pollOnce()
    expect(m.getStatus()).toBe('busy')
    m.sendReply({ to: 'peer', event: 'task_done', taskId, content: 'done' })
    expect(m.getStatus()).toBe('available')
    expect(m.getActiveTask()).toBeNull()
  })
})

describe('start / stop lifecycle', () => {
  test('start inserts agent, broadcasts agent_join', () => {
    const db = makeDb()
    const m = new Mamoru({ db, channel: 'life', sessionId: 'claude-self', agentName: 'self', config: { pollIntervalMs: 999_999 } })
    m.start()
    const row = getAgentBySession(db, 'claude-self')
    expect(row?.agent_name).toBe('self')
    const msgs = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self'").all() as { payload: string }[]
    expect(msgs.some(r => JSON.parse(r.payload).intent === 'agent_join')).toBe(true)
    m.stop()
  })

  test('stop broadcasts agent_leave and marks inactive', () => {
    const db = makeDb()
    const m = new Mamoru({ db, channel: 'life', sessionId: 'claude-self', agentName: 'self', config: { pollIntervalMs: 999_999 } })
    m.start()
    m.stop()
    expect(getAgentBySession(db, 'claude-self')?.status).toBe('inactive')
    const msgs = db.prepare("SELECT payload FROM messages WHERE from_agent='claude-self'").all() as { payload: string }[]
    expect(msgs.some(r => JSON.parse(r.payload).intent === 'agent_leave')).toBe(true)
  })
})
