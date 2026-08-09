import { describe, expect, test, beforeEach } from 'bun:test'
import type Database from 'better-sqlite3'
import { makeDb } from './helpers.ts'
import { Roster } from '../roster.ts'
import { registerAgent, updateAgentStatus } from '../db.ts'
import type { RosterEntry } from '../types.ts'

let db: Database.Database
beforeEach(() => { db = makeDb() })

function entry(id: string, status: 'available' | 'busy' | 'inactive' = 'available'): RosterEntry {
  return { session_id: id, agent_name: id, description: '', status, last_heartbeat: Date.now() }
}

describe('Roster basics', () => {
  test('update / get / remove / getAll', () => {
    const r = new Roster()
    r.update(entry('a'))
    r.update(entry('b', 'busy'))
    expect(r.get('a')?.session_id).toBe('a')
    expect(r.getAll().length).toBe(2)
    r.remove('a')
    expect(r.get('a')).toBeUndefined()
    expect(r.getAll().map(e => e.session_id)).toEqual(['b'])
  })

  test('getAvailable filters by status', () => {
    const r = new Roster()
    r.update(entry('a'))
    r.update(entry('b', 'busy'))
    expect(r.getAvailable().map(e => e.session_id)).toEqual(['a'])
  })

  test('markInactive flips status', () => {
    const r = new Roster()
    r.update(entry('a'))
    r.markInactive('a')
    expect(r.get('a')?.status).toBe('inactive')
  })
})

describe('Roster.initFromDb', () => {
  test('excludes self and inactive agents', () => {
    registerAgent(db, { session_id: 'self', agent_name: 'self', description: null, provider: null, model: null, cwd: null })
    registerAgent(db, { session_id: 'a', agent_name: 'alice', description: null, provider: null, model: null, cwd: null })
    registerAgent(db, { session_id: 'b', agent_name: 'bob', description: null, provider: null, model: null, cwd: null })
    updateAgentStatus(db, 'b', 'inactive')

    const r = new Roster()
    r.initFromDb(db, 'self')
    expect(r.getAll().map(e => e.session_id)).toEqual(['a'])
  })
})

describe('Roster diff/snapshot', () => {
  test('diff true on add, remove, or status change', () => {
    const r = new Roster()
    const s0 = r.snapshot()
    r.update(entry('a'))
    expect(r.diff(s0)).toBe(true)
    const s1 = r.snapshot()
    expect(r.diff(s1)).toBe(false)

    r.update(entry('a', 'busy'))
    expect(r.diff(s1)).toBe(true)

    const s2 = r.snapshot()
    r.remove('a')
    expect(r.diff(s2)).toBe(true)
  })
})

describe('Roster.markStale', () => {
  test('flips to inactive when heartbeat older than threshold', () => {
    const r = new Roster()
    const now = 10_000
    r.update({ ...entry('old'), last_heartbeat: now - 60_000 })
    r.update({ ...entry('fresh'), last_heartbeat: now - 1_000 })
    const staled = r.markStale(30_000, now)
    expect(staled).toEqual(['old'])
    expect(r.get('old')?.status).toBe('inactive')
    expect(r.get('fresh')?.status).toBe('available')
  })
  test('does not re-mark already-inactive entries', () => {
    const r = new Roster()
    r.update({ ...entry('x', 'inactive'), last_heartbeat: 0 })
    expect(r.markStale(30_000, 10_000_000)).toEqual([])
  })
})
