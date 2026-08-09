#!/usr/bin/env bun
// MCP stdio server: `mcp-teammate`. Wraps MAMORU + the channel notifier and
// exposes the pi-teammate slash command set as MCP prompts.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { createState, leaveActive } from './mcp/state.ts'
import { loadPersona } from './mcp/persona.ts'
import { PROMPT_SPECS, HANDLERS as PROMPT_HANDLERS } from './mcp/prompts.ts'
import { TOOL_SPECS, HANDLERS as TOOL_HANDLERS } from './mcp/tools.ts'
import { buildInstructions } from './mcp/instructions.ts'
import type { MamoruConfig } from './mamoru/types.ts'
import type { PersonaConfig } from './mcp/persona.ts'

const autoJoinChannel = process.env.MCP_TEAMMATE_AUTOJOIN_CHANNEL?.trim() || ''
const autoJoinAgentName = process.env.MCP_TEAMMATE_AUTOJOIN_AGENT_NAME?.trim() || ''
const autoJoinPersonaPath = process.env.MCP_TEAMMATE_AUTOJOIN_PERSONA_PATH?.trim() || ''

/** Parse a positive integer env var. Falls back and warns on garbage. */
function readMs(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[mcp-teammate] ignoring ${name}="${raw}" (not a positive number)`)
    return undefined
  }
  return n
}

const mamoruConfig: Partial<MamoruConfig> = {}
const pollMs = readMs('MCP_TEAMMATE_POLL_INTERVAL_MS')
const staleMs = readMs('MCP_TEAMMATE_STALE_HEARTBEAT_MS')
if (pollMs !== undefined) mamoruConfig.pollIntervalMs = pollMs
if (staleMs !== undefined) mamoruConfig.staleHeartbeatMs = staleMs

// Best-effort persona load on startup. Surface errors but keep the server
// running — the user can fix persona.yaml and rejoin without restarting.
let startupPersona: PersonaConfig | null = null
try {
  startupPersona = loadPersona(process.cwd())
} catch (err: any) {
  console.error(`[mcp-teammate] persona load failed: ${err.message}`)
}

const mcp = new Server(
  { name: 'mcp-teammate', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      prompts: {},
      tools: {},
    },
    instructions: buildInstructions(startupPersona),
  },
)

const state = createState({
  sender: { notification: n => mcp.notification(n as Parameters<typeof mcp.notification>[0]) },
  cwd: process.cwd(),
  persona: startupPersona,
  mamoruConfig,
})

let autoJoinStarted = false
async function maybeAutoJoin() {
  if (autoJoinStarted || !autoJoinChannel) return
  autoJoinStarted = true
  try {
    const args: Record<string, string> = { channel: autoJoinChannel }
    if (autoJoinAgentName) args.agent_name = autoJoinAgentName
    if (autoJoinPersonaPath) args.persona_path = autoJoinPersonaPath
    const text = await PROMPT_HANDLERS['team-join'](state, args)
    console.error(`[mcp-teammate] auto-joined: ${text}`)
  } catch (err: any) {
    console.error(`[mcp-teammate] auto-join failed: ${err.message}`)
  }
}
mcp.oninitialized = () => { void maybeAutoJoin() }

mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPT_SPECS.map(p => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  })),
}))

mcp.setRequestHandler(GetPromptRequestSchema, async req => {
  const handler = PROMPT_HANDLERS[req.params.name]
  if (!handler) throw new Error(`Unknown prompt: ${req.params.name}`)
  const args = (req.params.arguments ?? {}) as Record<string, string | undefined>
  let text: string
  try {
    text = await handler(state, args)
  } catch (err: any) {
    text = `Error: ${err.message}`
  }
  return {
    description: `Result of /${req.params.name}`,
    messages: [
      { role: 'user', content: { type: 'text', text } },
    ],
  }
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_SPECS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const handler = TOOL_HANDLERS[req.params.name]
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    }
  }
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    const text = await handler(state, args)
    return { content: [{ type: 'text', text }] }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    }
  }
})

// Clean shutdown: broadcast agent_leave + close DB before exiting.
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try { leaveActive(state) } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

await mcp.connect(new StdioServerTransport())
