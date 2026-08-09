import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSchema } from '../schema.ts'

describe('initSchema', () => {
  test('creates agents, messages, agent_cursors tables', () => {
    const db = new Database(':memory:', { strict: true })
    initSchema(db)
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const set = new Set(names.map(r => r.name))
    expect(set.has('agents')).toBe(true)
    expect(set.has('messages')).toBe(true)
    expect(set.has('agent_cursors')).toBe(true)
  })

  test('sets user_version=2', () => {
    const db = new Database(':memory:', { strict: true })
    initSchema(db)
    const row = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(2)
  })

  test('is idempotent', () => {
    const db = new Database(':memory:', { strict: true })
    initSchema(db)
    expect(() => initSchema(db)).not.toThrow()
  })
})
