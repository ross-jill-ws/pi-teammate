import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPersona } from '../persona.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'persona-test-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('returns null when persona.yaml absent', () => {
  expect(loadPersona(dir)).toBeNull()
})

test('loads minimal valid persona from a directory', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'name: Alice\ndescription: A helper\n')
  const p = loadPersona(dir)!
  expect(p.name).toBe('Alice')
  expect(p.description).toBe('A helper')
  expect(p.systemPrompt).toBeNull()
  expect(p.thinkingLevel).toBeNull()
})

test('explicit .yaml path bypasses cwd join', () => {
  const file = join(dir, 'custom.yaml')
  writeFileSync(file, 'name: Bob\ndescription: x\n')
  expect(loadPersona(file)?.name).toBe('Bob')
})

test('throws on missing required name', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'description: x\n')
  expect(() => loadPersona(dir)).toThrow(/'name' is required/)
})

test('throws on missing required description', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'name: Alice\n')
  expect(() => loadPersona(dir)).toThrow(/'description' is required/)
})

test('throws on bad thinkingLevel', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'name: A\ndescription: B\nthinkingLevel: ultra\n')
  expect(() => loadPersona(dir)).toThrow(/thinkingLevel/)
})

test('preserves user-defined extras', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'name: A\ndescription: B\ncontentWordLimit: 50\n')
  const p = loadPersona(dir)!
  expect(p.contentWordLimit).toBe(50)
})

test('throws on malformed YAML', () => {
  writeFileSync(join(dir, 'persona.yaml'), 'name: A\n  bad indent: : :\n')
  expect(() => loadPersona(dir)).toThrow()
})
