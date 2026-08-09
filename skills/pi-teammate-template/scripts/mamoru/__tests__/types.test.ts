import { describe, expect, test } from 'bun:test'
import {
  countWords,
  createPayload,
  isNewTaskReq,
  newClaudeSessionId,
  parsePayload,
  MAX_CONTENT_WORDS,
} from '../types.ts'
import type { MessageRow } from '../types.ts'

describe('countWords', () => {
  test('empty string is 0', () => expect(countWords('')).toBe(0))
  test('single word', () => expect(countWords('hello')).toBe(1))
  test('multi whitespace collapsed', () => expect(countWords('a   b\tc\n d')).toBe(4))
  test('leading/trailing whitespace ignored', () => expect(countWords('  hi there  ')).toBe(2))
})

describe('parsePayload', () => {
  test('valid payload round-trips', () => {
    const raw = JSON.stringify({ event: 'broadcast', content: 'hi', intent: null, need_reply: false, detail: null })
    expect(parsePayload(raw)).toMatchObject({ event: 'broadcast', content: 'hi' })
  })
  test('missing event field returns null', () => {
    expect(parsePayload(JSON.stringify({ content: 'hi' }))).toBeNull()
  })
  test('missing content field returns null', () => {
    expect(parsePayload(JSON.stringify({ event: 'broadcast' }))).toBeNull()
  })
  test('malformed JSON returns null', () => {
    expect(parsePayload('{not json')).toBeNull()
  })
})

describe('createPayload', () => {
  test('applies defaults', () => {
    expect(createPayload('broadcast', 'hi')).toEqual({
      event: 'broadcast', content: 'hi', intent: null, need_reply: false, detail: null,
    })
  })
  test('honours overrides', () => {
    expect(createPayload('task_req', 'do it', { intent: 'x', need_reply: true, detail: '/tmp/a.md' })).toEqual({
      event: 'task_req', content: 'do it', intent: 'x', need_reply: true, detail: '/tmp/a.md',
    })
  })
})

describe('isNewTaskReq', () => {
  test('true when task_id === message_id', () => {
    const msg = { message_id: 7, task_id: 7 } as MessageRow
    expect(isNewTaskReq(msg)).toBe(true)
  })
  test('false when task_id differs', () => {
    const msg = { message_id: 8, task_id: 7 } as MessageRow
    expect(isNewTaskReq(msg)).toBe(false)
  })
  test('false when task_id is null', () => {
    const msg = { message_id: 8, task_id: null } as MessageRow
    expect(isNewTaskReq(msg)).toBe(false)
  })
})

describe('newClaudeSessionId', () => {
  test('has claude- prefix', () => {
    expect(newClaudeSessionId().startsWith('claude-')).toBe(true)
  })
  test('unique per call', () => {
    expect(newClaudeSessionId()).not.toBe(newClaudeSessionId())
  })
})

describe('MAX_CONTENT_WORDS', () => {
  test('is 20', () => expect(MAX_CONTENT_WORDS).toBe(20))
})
