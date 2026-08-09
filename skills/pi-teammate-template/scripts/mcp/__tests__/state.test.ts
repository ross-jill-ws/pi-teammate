import { beforeEach, describe, expect, test } from 'bun:test'
import { createState, isJoined, leaveActive } from '../state.ts'

function makeSender() {
  return { notification: () => {} }
}

describe('state helpers', () => {
  test('createState initializes an empty disconnected state', () => {
    const state = createState({ sender: makeSender(), cwd: '/tmp/project' })
    expect(state.cwd).toBe('/tmp/project')
    expect(state.channel).toBeNull()
    expect(state.db).toBeNull()
    expect(state.mamoru).toBeNull()
    expect(state.persona).toBeNull()
    expect(state.sessionId).toBeNull()
    expect(state.mamoruConfig).toEqual({})
  })

  test('isJoined reflects whether mamoru is active', () => {
    const state = createState({ sender: makeSender(), cwd: '/tmp/project' })
    expect(isJoined(state)).toBe(false)
    state.mamoru = {} as any
    expect(isJoined(state)).toBe(true)
  })

  test('leaveActive stops mamoru, closes db, and clears active fields', () => {
    const calls: string[] = []
    const state = createState({ sender: makeSender(), cwd: '/tmp/project' })
    state.channel = 'demo'
    state.sessionId = 'claude-123'
    state.mamoru = { stop: () => calls.push('stop') } as any
    state.db = { close: () => calls.push('close') } as any

    leaveActive(state)

    expect(calls).toEqual(['stop', 'close'])
    expect(state.channel).toBeNull()
    expect(state.sessionId).toBeNull()
    expect(state.mamoru).toBeNull()
    expect(state.db).toBeNull()
  })

  test('leaveActive swallows teardown errors and still clears fields', () => {
    const state = createState({ sender: makeSender(), cwd: '/tmp/project' })
    state.channel = 'demo'
    state.sessionId = 'claude-123'
    state.mamoru = { stop: () => { throw new Error('stop failed') } } as any
    state.db = { close: () => { throw new Error('close failed') } } as any

    expect(() => leaveActive(state)).not.toThrow()
    expect(state.channel).toBeNull()
    expect(state.sessionId).toBeNull()
    expect(state.mamoru).toBeNull()
    expect(state.db).toBeNull()
  })
})
