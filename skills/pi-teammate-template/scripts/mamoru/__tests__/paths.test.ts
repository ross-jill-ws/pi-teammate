import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseDir, channelExists, getChannelDir, getDbPath, getTeammateDir } from '../paths.ts'

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mamoru-paths-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('paths', () => {
  test('baseDir resolves under HOME/.pi/pi-teammate', () => {
    expect(baseDir()).toBe(join(tmpHome, '.pi', 'pi-teammate'))
  })

  test('getChannelDir nests channel name under base', () => {
    expect(getChannelDir('foo')).toBe(join(tmpHome, '.pi', 'pi-teammate', 'foo'))
  })

  test('getDbPath ends with team.db', () => {
    expect(getDbPath('foo')).toBe(join(tmpHome, '.pi', 'pi-teammate', 'foo', 'team.db'))
  })

  test('getTeammateDir creates the directory', () => {
    const dir = getTeammateDir('foo', 'claude-abc')
    expect(existsSync(dir)).toBe(true)
    expect(dir).toBe(join(tmpHome, '.pi', 'pi-teammate', 'foo', 'claude-abc'))
  })

  test('channelExists false when team.db absent, true when present', () => {
    expect(channelExists('foo')).toBe(false)
    const dir = getChannelDir('foo')
    getTeammateDir('foo', '_init') // create parent dir
    writeFileSync(getDbPath('foo'), '')
    expect(channelExists('foo')).toBe(true)
    // silence unused var warning
    expect(dir.length).toBeGreaterThan(0)
  })
})
