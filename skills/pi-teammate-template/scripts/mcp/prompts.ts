// MCP prompt handlers — one entry per slash command. Mirrors
// pi-teammate/extensions/commands.ts. Each handler runs side-effectful work
// (DB writes, MAMORU lifecycle) and returns a short text result that Claude
// Code surfaces to the user.
//
// All handlers are pure-ish: they take a `ServerState` + parsed args and
// return a string. Tests drive them directly (no MCP transport needed).

import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Mamoru, openChannelDb, initSchema, getChannelDir, getDbPath, channelExists,
  sendMessage, deleteAgent, getInactiveAgentsByName, getMessagesByTaskId,
  createPayload, parsePayload, newClaudeSessionId,
  type MessageRow,
} from '../mamoru/index.ts'
import { ChannelNotifier } from './channel-notifier.ts'
import { loadPersona } from './persona.ts'
import type { ServerState } from './state.ts'
import { isJoined, leaveActive } from './state.ts'

// ── small helpers ────────────────────────────────────────────────────

function fmtTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function requireJoined(state: ServerState): asserts state is ServerState & { mamoru: NonNullable<ServerState['mamoru']>; db: NonNullable<ServerState['db']>; channel: string; sessionId: string } {
  if (!isJoined(state)) {
    throw new Error('Not connected to any team channel. Use /team-join first.')
  }
}

// ── prompt schema for ListPromptsRequest ─────────────────────────────

export interface PromptSpec {
  name: string
  description: string
  arguments: { name: string; description: string; required: boolean }[]
}

export const PROMPT_SPECS: PromptSpec[] = [
  { name: 'team-create', description: 'Create (or recreate) a team channel DB. Deletes existing channel data if present.', arguments: [
    { name: 'channel', description: 'Channel name (defaults to a fresh claude-<uuid>)', required: false },
  ]},
  { name: 'team-join', description: 'Join a team channel and start polling.', arguments: [
    { name: 'channel', description: 'Channel name', required: true },
    { name: 'agent_name', description: 'Override agent name (defaults to persona.name then claude-<uuid>)', required: false },
    { name: 'persona_path', description: 'Path to a persona.yaml (defaults to ./persona.yaml in cwd)', required: false },
  ]},
  { name: 'team-leave', description: 'Leave the current team channel.', arguments: [] },
  { name: 'team-remove-inactive', description: 'Remove inactive teammate sessions sharing your agent name.', arguments: [] },
  { name: 'team-send', description: 'Send a manual debug broadcast to a teammate.', arguments: [
    { name: 'to', description: 'Target session id', required: true },
    { name: 'message', description: 'Message body', required: true },
  ]},
  { name: 'team-status', description: 'Show channel, agent, status, active task, outbound count.', arguments: [] },
  { name: 'team-roster', description: 'Show all agents in the in-memory roster.', arguments: [] },
  { name: 'team-history', description: 'Show last N channel messages (readonly).', arguments: [
    { name: 'n', description: 'Message count (default 20)', required: false },
  ]},
  { name: 'task-status', description: 'Show active inbound + outbound tasks with elapsed time.', arguments: [] },
  { name: 'task-list', description: 'List all task_req messages on the channel.', arguments: [] },
  { name: 'task-cancel', description: 'Send task_cancel to the worker for an outbound task.', arguments: [
    { name: 'task_id', description: 'Numeric task id', required: true },
  ]},
  { name: 'task-history', description: 'Show all messages for a given task id.', arguments: [
    { name: 'task_id', description: 'Numeric task id', required: true },
  ]},
  { name: 'persona-template', description: 'Write a persona.yaml template into the current directory.', arguments: [] },
]

// ── handler dispatch ─────────────────────────────────────────────────

export type PromptArgs = Record<string, string | undefined>
export type PromptHandler = (state: ServerState, args: PromptArgs) => string | Promise<string>

export const HANDLERS: Record<string, PromptHandler> = {
  'team-create': handleTeamCreate,
  'team-join': handleTeamJoin,
  'team-leave': handleTeamLeave,
  'team-remove-inactive': handleTeamRemoveInactive,
  'team-send': handleTeamSend,
  'team-status': handleTeamStatus,
  'team-roster': handleTeamRoster,
  'team-history': handleTeamHistory,
  'task-status': handleTaskStatus,
  'task-list': handleTaskList,
  'task-cancel': handleTaskCancel,
  'task-history': handleTaskHistory,
  'persona-template': handlePersonaTemplate,
}

// ── individual handlers ──────────────────────────────────────────────

function handleTeamCreate(state: ServerState, args: PromptArgs): string {
  const channel = args.channel?.trim() || newClaudeSessionId()
  const dir = getChannelDir(channel)
  const dbPath = getDbPath(channel)
  let recreated = false
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    recreated = true
  }
  mkdirSync(dir, { recursive: true })
  const db = openChannelDb(dbPath)
  try { initSchema(db) } finally { db.close() }
  return `${recreated ? 'Recreated' : 'Created'} channel "${channel}" at ${dbPath}`
}

function handleTeamJoin(state: ServerState, args: PromptArgs): string {
  if (isJoined(state)) {
    throw new Error(`Already joined "${state.channel}" as "${state.mamoru!.agentName}". Use /team-leave first.`)
  }
  const channel = args.channel?.trim()
  if (!channel) throw new Error('Usage: /team-join <channel> [agent_name] [persona_path]')

  // Load persona: explicit path > startup-loaded > cwd default. We re-load
  // here so users can drop a new persona.yaml mid-session and have it picked up.
  const personaPath = args.persona_path?.trim()
  const persona = personaPath
    ? loadPersona(personaPath)
    : (state.persona ?? loadPersona(state.cwd))
  if (personaPath && !persona) {
    throw new Error(`No persona file found at ${personaPath}`)
  }
  state.persona = persona

  const agentName = args.agent_name?.trim() || persona?.name || newClaudeSessionId()

  if (!channelExists(channel)) {
    mkdirSync(getChannelDir(channel), { recursive: true })
    const tmp = openChannelDb(getDbPath(channel))
    try { initSchema(tmp) } finally { tmp.close() }
  }

  const db = openChannelDb(getDbPath(channel))
  const mamoru = new Mamoru({
    db,
    channel,
    agentName,
    description: persona?.description ?? undefined,
    cwd: state.cwd,
    notifier: new ChannelNotifier(state.sender),
    config: state.mamoruConfig,
  })
  mamoru.start()

  state.db = db
  state.channel = channel
  state.mamoru = mamoru
  state.sessionId = mamoru.sessionId

  return `Joined channel "${channel}" as "${agentName}" (${mamoru.sessionId})`
}

function handleTeamLeave(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const { channel, mamoru } = state
  const name = mamoru.agentName
  leaveActive(state)
  return `Left channel "${channel}" (was "${name}")`
}

function handleTeamRemoveInactive(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const { db, mamoru, channel, sessionId } = state
  const inactive = getInactiveAgentsByName(db, mamoru.agentName, sessionId)
  if (inactive.length === 0) {
    return `No inactive sessions found for "${mamoru.agentName}".`
  }
  const ids: string[] = []
  for (const agent of inactive) {
    const payload = createPayload('broadcast', `${agent.agent_name} has left the channel`, {
      intent: 'agent_leave',
    })
    sendMessage(db, {
      from_agent: agent.session_id,
      to_agent: null,
      channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(payload),
    })
    deleteAgent(db, agent.session_id)
    ids.push(agent.session_id)
  }
  return `Removed ${inactive.length} inactive "${mamoru.agentName}" session${inactive.length === 1 ? '' : 's'}: ${ids.join(', ')}`
}

function handleTeamSend(state: ServerState, args: PromptArgs): string {
  requireJoined(state)
  const to = args.to?.trim()
  const message = args.message?.trim()
  if (!to || !message) throw new Error('Usage: /team-send <to> <message>')
  const payload = createPayload('broadcast', message)
  const msgId = sendMessage(state.db, {
    from_agent: state.sessionId,
    to_agent: to,
    channel: state.channel,
    task_id: null,
    ref_message_id: null,
    payload: JSON.stringify(payload),
  })
  return `Message #${msgId} sent to "${to}"`
}

function handleTeamStatus(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const { mamoru } = state
  const active = mamoru.getActiveTask()
  const outbound = mamoru.getOutboundTasks()
  const lines = [
    `Channel: ${mamoru.channel}`,
    `Agent: ${mamoru.agentName} (${mamoru.sessionId})`,
    `Status: ${mamoru.getStatus()}`,
    `Active Task: ${active ? `#${active.taskId} from ${active.requesterSessionId} (${fmtElapsed(Date.now() - active.startedAt)} ago)` : 'none'}`,
    `Outbound Tasks: ${outbound.size}`,
  ]
  return lines.join('\n')
}

function handleTeamRoster(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const entries = state.mamoru.getRoster().getAll()
  if (entries.length === 0) return 'Roster is empty (no other agents online).'
  const lines = entries.map(e =>
    `  ${e.agent_name} (${e.session_id}) — ${e.status} — ${e.description || '(no description)'}`,
  )
  return `Roster (${entries.length} agents):\n${lines.join('\n')}`
}

function handleTeamHistory(state: ServerState, args: PromptArgs): string {
  requireJoined(state)
  const n = Math.max(1, parseInt(args.n?.trim() ?? '', 10) || 20)
  const rows = state.db
    .prepare('SELECT * FROM messages WHERE channel = ? ORDER BY message_id DESC LIMIT ?')
    .all(state.channel, n) as MessageRow[]
  if (rows.length === 0) return 'No messages found.'
  rows.reverse()
  const lines = rows.map(row => {
    const payload = parsePayload(row.payload)
    const event = payload?.event ?? '?'
    const content = payload?.content ?? '(unparseable)'
    const to = row.to_agent ? ` → ${row.to_agent}` : ''
    const task = row.task_id ? ` [task #${row.task_id}]` : ''
    return `#${row.message_id} [${fmtTimestamp(row.created_at)}] ${row.from_agent}${to}${task} (${event}): ${content}`
  })
  return `Last ${rows.length} messages:\n${lines.join('\n')}`
}

function handleTaskStatus(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const { mamoru } = state
  const now = Date.now()
  const active = mamoru.getActiveTask()
  const outbound = mamoru.getOutboundTasks()
  const lines: string[] = []
  if (active) {
    lines.push(`Active (inbound) task #${active.taskId}`)
    lines.push(`  From: ${active.requesterSessionId}`)
    lines.push(`  Started: ${fmtElapsed(now - active.startedAt)} ago`)
  } else {
    lines.push('No active inbound task.')
  }
  if (outbound.size > 0) {
    lines.push('')
    lines.push(`Outbound tasks (${outbound.size}):`)
    for (const [taskId, task] of outbound) {
      lines.push(`  #${taskId} → ${task.workerSessionId} (sent ${fmtElapsed(now - task.sentAt)} ago, last event ${fmtElapsed(now - task.lastEventAt)} ago)`)
    }
  } else {
    lines.push('No outbound tasks.')
  }
  return lines.join('\n')
}

function handleTaskList(state: ServerState, _args: PromptArgs): string {
  requireJoined(state)
  const rows = state.db
    .prepare('SELECT * FROM messages WHERE channel = ? AND task_id = message_id ORDER BY message_id DESC')
    .all(state.channel) as MessageRow[]
  if (rows.length === 0) return 'No tasks found.'
  const lines = rows.map(row => {
    const payload = parsePayload(row.payload)
    const content = payload?.content ?? '(unparseable)'
    const to = row.to_agent ? ` → ${row.to_agent}` : ' (broadcast)'
    return `Task #${row.message_id} [${fmtTimestamp(row.created_at)}] ${row.from_agent}${to}: ${content}`
  })
  return `Tasks (${rows.length}):\n${lines.join('\n')}`
}

function handleTaskCancel(state: ServerState, args: PromptArgs): string {
  requireJoined(state)
  const taskId = parseInt(args.task_id?.trim() ?? '', 10)
  if (isNaN(taskId)) throw new Error('Usage: /task-cancel <task_id>')
  const task = state.mamoru.getOutboundTasks().get(taskId)
  if (!task) throw new Error(`No outbound task #${taskId} found.`)
  const payload = createPayload('task_cancel', 'Cancelled by user', {
    intent: 'user_cancel',
    need_reply: true,
  })
  const msgId = sendMessage(state.db, {
    from_agent: state.sessionId,
    to_agent: task.workerSessionId,
    channel: state.channel,
    task_id: taskId,
    ref_message_id: taskId,
    payload: JSON.stringify(payload),
  })
  return `Sent task_cancel for task #${taskId} (message #${msgId})`
}

function handleTaskHistory(state: ServerState, args: PromptArgs): string {
  requireJoined(state)
  const taskId = parseInt(args.task_id?.trim() ?? '', 10)
  if (isNaN(taskId)) throw new Error('Usage: /task-history <task_id>')
  const rows = getMessagesByTaskId(state.db, taskId)
  if (rows.length === 0) return `No messages found for task #${taskId}.`
  const lines = rows.map(row => {
    const payload = parsePayload(row.payload)
    const event = payload?.event ?? '?'
    const content = payload?.content ?? '(unparseable)'
    const to = row.to_agent ? ` → ${row.to_agent}` : ''
    return `#${row.message_id} [${fmtTimestamp(row.created_at)}] ${row.from_agent}${to} (${event}): ${content}`
  })
  return `Task #${taskId} history (${rows.length} messages):\n${lines.join('\n')}`
}

function handlePersonaTemplate(state: ServerState, _args: PromptArgs): string {
  const filePath = join(state.cwd, 'persona.yaml')
  if (existsSync(filePath)) {
    throw new Error(`persona.yaml already exists at ${filePath}. Will not overwrite.`)
  }
  const dirName = state.cwd.split(/[\/\\]/).filter(Boolean).pop() || 'Agent'
  const name = dirName.charAt(0).toUpperCase() + dirName.slice(1)
  const template = [
    `name: "${name}"`,
    'description: ""',
    'systemPrompt: ""',
    '',
    '# The following fields are honored by pi-teammate but ignored by mcp-teammate:',
    '# provider: "anthropic"',
    '# model: "claude-sonnet-4-5"',
    '# thinkingLevel: "medium"',
    '',
  ].join('\n')
  writeFileSync(filePath, template, 'utf-8')
  return `Created persona.yaml at ${filePath}`
}
