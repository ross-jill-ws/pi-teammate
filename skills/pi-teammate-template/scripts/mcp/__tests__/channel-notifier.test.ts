import { test, expect } from 'bun:test'
import { ChannelNotifier, type NotificationSender } from '../channel-notifier.ts'

function spy(): NotificationSender & { calls: { method: string; params?: unknown }[] } {
  const calls: { method: string; params?: unknown }[] = []
  return { calls, notification: n => { calls.push(n) } }
}

test('steer emits notifications/claude/channel with content + meta', () => {
  const s = spy()
  new ChannelNotifier(s).steer('hello', { event: 'task_req', task_id: '7' })
  expect(s.calls).toHaveLength(1)
  expect(s.calls[0].method).toBe('notifications/claude/channel')
  expect(s.calls[0].params).toEqual({ content: 'hello', meta: { event: 'task_req', task_id: '7' } })
})

test('steer defaults meta to {} when omitted', () => {
  const s = spy()
  new ChannelNotifier(s).steer('hi')
  expect((s.calls[0].params as any).meta).toEqual({})
})

test('steer swallows sender promise rejection without throwing', () => {
  const sender: NotificationSender = { notification: () => Promise.reject(new Error('boom')) }
  // Should not throw synchronously
  expect(() => new ChannelNotifier(sender).steer('x')).not.toThrow()
})
