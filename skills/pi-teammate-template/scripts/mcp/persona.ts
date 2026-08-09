// Persona loader. Mirrors pi-teammate/extensions/persona.ts so persona.yaml
// files are portable between the two systems. Fields we can't act on in
// Claude Code (provider, model, thinkingLevel) are loaded but ignored —
// loadPersona() reports them once via console.warn so users know.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

export interface PersonaConfig {
  name: string
  description: string
  provider: string | null
  model: string | null
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | null
  systemPrompt: string | null
  [key: string]: unknown
}

const PERSONA_FILE = 'persona.yaml'
const KNOWN_KEYS = new Set([
  'name', 'description', 'provider', 'model', 'thinkingLevel', 'systemPrompt',
])

// Fields that pi-teammate honors but Claude Code can't act on. We log them
// once on load so the user knows they're being ignored. provider/model are
// NOT listed: the pi-teammate-template skill writes them into Claude Code
// teammate personas ("anthropic"/"opus") as roster metadata by design.
const IGNORED_IN_CLAUDE = ['thinkingLevel'] as const

/**
 * Load a persona file. Pass an explicit path, or a directory whose
 * `persona.yaml` we should read. Returns null when no file is found.
 * Throws on malformed YAML or missing required fields.
 */
export function loadPersona(pathOrDir: string): PersonaConfig | null {
  const filePath = pathOrDir.endsWith('.yaml') || pathOrDir.endsWith('.yml')
    ? pathOrDir
    : join(pathOrDir, PERSONA_FILE)

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }

  let doc: any
  try {
    doc = YAML.parse(raw)
  } catch (err: any) {
    throw new Error(`Invalid YAML in ${filePath}: ${err.message}`)
  }

  if (doc == null || typeof doc !== 'object') {
    throw new Error(`Invalid persona at ${filePath}: expected a YAML mapping, got ${typeof doc}`)
  }

  const { name, description } = doc
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`persona at ${filePath}: 'name' is required and must be a non-empty string`)
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`persona at ${filePath}: 'description' is required and must be a non-empty string`)
  }

  const validThinking = new Set(['off', 'low', 'medium', 'high'])
  let thinkingLevel: PersonaConfig['thinkingLevel'] = null
  if (doc.thinkingLevel != null) {
    if (typeof doc.thinkingLevel !== 'string' || !validThinking.has(doc.thinkingLevel)) {
      throw new Error(
        `persona at ${filePath}: 'thinkingLevel' must be one of off, low, medium, high (got ${JSON.stringify(doc.thinkingLevel)})`,
      )
    }
    thinkingLevel = doc.thinkingLevel as PersonaConfig['thinkingLevel']
  }

  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v
  }

  const ignored = IGNORED_IN_CLAUDE.filter(k => doc[k] != null)
  if (ignored.length > 0) {
    console.warn(`[mcp-teammate] persona at ${filePath} sets ${ignored.join(', ')} — ignored under Claude Code.`)
  }

  return {
    name: name.trim(),
    description: description.trim(),
    provider: typeof doc.provider === 'string' ? doc.provider : null,
    model: typeof doc.model === 'string' ? doc.model : null,
    thinkingLevel,
    systemPrompt: typeof doc.systemPrompt === 'string' && doc.systemPrompt.trim() !== ''
      ? doc.systemPrompt.trim()
      : null,
    ...extras,
  }
}
