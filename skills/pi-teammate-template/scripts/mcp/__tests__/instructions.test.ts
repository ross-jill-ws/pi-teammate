import { test, expect } from 'bun:test'
import { buildInstructions } from '../instructions.ts'

test('null persona returns BASE-only instructions', () => {
  const out = buildInstructions(null)
  expect(out).toMatch(/mcp-teammate runs a peer-to-peer messaging channel/)
  expect(out).not.toMatch(/Persona:/)
})

test('persona with systemPrompt prepends it before BASE', () => {
  const out = buildInstructions({
    name: 'Alice', description: 'helper', provider: null, model: null,
    thinkingLevel: null, systemPrompt: 'Speak like a pirate.',
  })
  expect(out.indexOf('Speak like a pirate.')).toBeLessThan(out.indexOf('mcp-teammate runs'))
  expect(out).toMatch(/Persona: Alice — helper/)
  expect(out).toMatch(/---/)
})

test('persona without systemPrompt still contributes a Persona: line', () => {
  const out = buildInstructions({
    name: 'Bob', description: 'worker', provider: null, model: null,
    thinkingLevel: null, systemPrompt: null,
  })
  expect(out).toMatch(/Persona: Bob — worker/)
  expect(out).toMatch(/mcp-teammate runs/)
})
