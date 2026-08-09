// MCP tool handlers. Mirrors the prompts.ts style: one spec array for
// ListToolsRequest, one HANDLERS map for CallToolRequest dispatch, one
// function per tool.
//
// Tools:
//   - send-message-to-teammate — outbound messages to peers. Thin wrapper
//     around Mamoru.send() plus detail-file path validation.
//   - get-team-roster           — read-only view of channel membership +
//     per-teammate status, used by the LLM to decide who to send to.

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  MESSAGE_EVENTS, MAMORU_RESERVED_EVENTS, getTeammateDir,
} from '../mamoru/index.ts'
import type { ServerState } from './state.ts'
import { isJoined } from './state.ts'

// ── spec schema for ListToolsRequest ─────────────────────────────────

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const SENDABLE_EVENTS = MESSAGE_EVENTS.filter(e => !MAMORU_RESERVED_EVENTS.includes(e))

const SEND_DESCRIPTION = [
  'Send a message to a teammate on the joined channel.',
  '',
  'Always call `get-team-roster` FIRST, every time, to confirm the current',
  'recipient list and their status — the roster can change between turns',
  'without notice.',
  '',
  'Rules:',
  '- `content` is a short summary (≤ 20 words). Put anything longer into a',
  '  markdown detail file and pass its absolute path in `detail`.',
  '- `detail` must be an absolute path under the sender-owned teammate dir',
  '  at ~/.pi/pi-teammate/<channel>/<your session_id>/. The detail file must',
  '  already exist before calling this tool.',
  '- `detail` is REQUIRED for event=task_req. Strongly recommended for',
  '  task_done and task_fail.',
  '- Reserved events (ping, pong, task_ack, task_reject, task_cancel_ack)',
  '  are sent automatically by the server and cannot be invoked here.',
  '- For replies (task_done, task_fail, task_update, task_clarify, etc.),',
  '  you may omit `to` and `task_id` — they default to the active inbound',
  '  task.',
].join('\n')

const ROSTER_DESCRIPTION = [
  'List all teammates currently on the joined channel, with each one\'s',
  'status (available / busy / inactive) and, when known, which task is',
  'keeping a busy teammate occupied. Safe to call repeatedly — call this',
  'before every `send-message-to-teammate` to get the freshest roster.',
].join('\n')

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'send-message-to-teammate',
    description: SEND_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient session id. Omit for broadcast. Required for task_req.' },
        event: { type: 'string', enum: SENDABLE_EVENTS, description: 'Message event type.' },
        task_id: { type: 'number', description: 'Originating task_req message id. Required for replies unless an active inbound task is in progress (then auto-filled).' },
        ref_message_id: { type: 'number', description: 'The message you are responding to. Usually the same as task_id for replies.' },
        content: { type: 'string', description: 'Short summary, ≤ 20 words. Put the long form in the detail file.' },
        detail: { type: 'string', description: 'Absolute path to a markdown detail file. REQUIRED for task_req. Must live under ~/.pi/pi-teammate/<channel>/<your session_id>/.' },
        intent: { type: 'string', description: 'Freeform intent hint (optional).' },
        blocking: { type: 'boolean', description: 'task_req only. If true, MAMORU silently re-queues on task_reject until the target is available.' },
      },
      required: ['event', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get-team-roster',
    description: ROSTER_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

// ── dispatch ─────────────────────────────────────────────────────────

export type ToolArgs = Record<string, unknown>
export type ToolHandler = (state: ServerState, args: ToolArgs) => string | Promise<string>

export const HANDLERS: Record<string, ToolHandler> = {
  'send-message-to-teammate': handleSendMessage,
  'get-team-roster': handleGetRoster,
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function requireJoined(state: ServerState): asserts state is ServerState & {
  mamoru: NonNullable<ServerState['mamoru']>
  db: NonNullable<ServerState['db']>
  channel: string
  sessionId: string
} {
  if (!isJoined(state)) {
    throw new Error('Not joined — call /mcp__mcp-teammate__team-join first.')
  }
}

function str(args: ToolArgs, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`)
  const trimmed = v.trim()
  return trimmed === '' ? undefined : trimmed
}

function num(args: ToolArgs, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`)
  return v
}

function bool(args: ToolArgs, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Error(`"${key}" must be a boolean`)
  return v
}

// ── handlers ─────────────────────────────────────────────────────────

function handleSendMessage(state: ServerState, args: ToolArgs): string {
  requireJoined(state)

  const event = str(args, 'event')
  if (!event) throw new Error('Missing required field: event')
  const content = str(args, 'content')
  if (!content) throw new Error('Missing required field: content')

  const to = str(args, 'to')
  const taskId = num(args, 'task_id')
  const refMessageId = num(args, 'ref_message_id')
  const detail = str(args, 'detail')
  const intent = str(args, 'intent')
  const blocking = bool(args, 'blocking')

  if (event === 'task_req' && !detail) {
    throw new Error('task_req requires a `detail` markdown file (absolute path).')
  }

  if (detail !== undefined) {
    if (!isAbsolute(detail)) {
      throw new Error(`detail must be an absolute path (got "${detail}")`)
    }
    if (!existsSync(detail)) {
      throw new Error(`detail file does not exist: ${detail}`)
    }
    const ownDir = getTeammateDir(state.channel, state.sessionId)
    const ownReal = realpathSync(ownDir)
    const detailReal = realpathSync(detail)
    if (!detailReal.startsWith(ownReal + '/') && detailReal !== ownReal) {
      throw new Error(
        `detail must live under your teammate dir at ${ownDir}. Got: ${detail}`,
      )
    }
  }

  const result = state.mamoru.send({
    to: to ?? null,
    event: event as any,
    taskId: taskId ?? null,
    refMessageId: refMessageId ?? null,
    content,
    detail: detail ?? null,
    intent: intent ?? null,
    blocking,
  })

  if (event === 'task_req') {
    const target = state.mamoru.getRoster().get(result.resolvedTo!)
    const name = target?.agent_name ?? result.resolvedTo
    const retryNote = blocking
      ? ' Blocking: MAMORU will auto-retry on task_reject until they are available.'
      : ''
    return `Task #${result.taskId} sent to ${name} (${result.resolvedTo}).${retryNote}`
  }
  const target = result.resolvedTo ?? '(broadcast)'
  return `Message #${result.messageId} (${event}) sent to ${target}.`
}

function handleGetRoster(state: ServerState, _args: ToolArgs): string {
  requireJoined(state)
  const { mamoru } = state
  const entries = mamoru.getRoster().getAll()
  const lines: string[] = []
  lines.push(`Channel: ${mamoru.channel}`)
  lines.push(`Your session: ${mamoru.sessionId} (${mamoru.agentName}, ${mamoru.getStatus()})`)
  if (entries.length === 0) {
    lines.push('Teammates: none.')
    return lines.join('\n')
  }
  lines.push(`Teammates (${entries.length}):`)

  // Map workerSessionId → outbound task (so "busy" peers we delegated to can
  // be annotated as "busy (task #N from you, HH:MM:SS)").
  const now = Date.now()
  const byWorker = new Map<string, { taskId: number; sentAt: number }>()
  for (const [taskId, t] of mamoru.getOutboundTasks()) {
    byWorker.set(t.workerSessionId, { taskId, sentAt: t.sentAt })
  }

  for (const e of entries) {
    let status: string = e.status
    if (e.status === 'busy') {
      const mine = byWorker.get(e.session_id)
      if (mine) {
        status = `busy (task #${mine.taskId} from you, ${fmtDuration(now - mine.sentAt)})`
      }
    }
    const desc = e.description ? ` — "${e.description}"` : ''
    lines.push(`  - ${e.agent_name} (${e.session_id}) — ${status}${desc}`)
  }
  return lines.join('\n')
}
