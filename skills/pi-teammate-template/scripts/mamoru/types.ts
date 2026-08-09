// Shared types for MAMORU + DB. Mirrors pi-teammate/extensions/types.ts
// but with all pi-framework specifics stripped out.

export type AgentStatus = 'available' | 'busy' | 'inactive'

export type MessageEvent =
  | 'broadcast'
  | 'info_only'
  | 'ping'
  | 'pong'
  | 'task_req'
  | 'task_ack'
  | 'task_reject'
  | 'task_clarify'
  | 'task_clarify_res'
  | 'task_update'
  | 'task_done'
  | 'task_fail'
  | 'task_cancel'
  | 'task_cancel_ack'

export const MESSAGE_EVENTS: readonly MessageEvent[] = [
  'broadcast', 'info_only',
  'ping', 'pong',
  'task_req', 'task_ack', 'task_reject',
  'task_clarify', 'task_clarify_res',
  'task_update', 'task_done', 'task_fail',
  'task_cancel', 'task_cancel_ack',
] as const

export const TASK_ID_REQUIRED_EVENTS: readonly MessageEvent[] = [
  'task_ack', 'task_reject',
  'task_clarify', 'task_clarify_res',
  'task_update', 'task_done', 'task_fail',
  'task_cancel', 'task_cancel_ack',
] as const

export interface MessagePayload {
  event: MessageEvent
  intent: string | null
  need_reply: boolean
  content: string
  detail: string | null
}

export const MAX_CONTENT_WORDS = 20

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export interface AgentRow {
  session_id: string
  agent_name: string
  description: string | null
  provider: string | null
  model: string | null
  cwd: string | null
  status: AgentStatus
  last_heartbeat: number | null
}

export interface MessageRow {
  message_id: number
  from_agent: string
  to_agent: string | null
  channel: string
  task_id: number | null
  ref_message_id: number | null
  payload: string
  created_at: number
}

export interface CursorRow {
  session_id: string
  channel: string
  last_read_id: number
}

export interface RosterEntry {
  session_id: string
  agent_name: string
  description: string
  status: AgentStatus
  last_heartbeat: number
}

export interface MamoruConfig {
  pollIntervalMs: number
  staleHeartbeatMs: number
  contentWordLimit: number
}

export const DEFAULT_MAMORU_CONFIG: MamoruConfig = {
  pollIntervalMs: 1000,
  staleHeartbeatMs: 30_000,
  contentWordLimit: MAX_CONTENT_WORDS,
}

export const MAMORU_RESERVED_EVENTS: readonly MessageEvent[] = [
  'ping', 'pong', 'task_ack', 'task_reject', 'task_cancel_ack',
] as const

export interface OutboundTask {
  taskId: number
  workerSessionId: string
  sentAt: number
  lastEventAt: number
}

export interface PendingRetry {
  targetSessionId: string
  content: string
  detail: string | null
  intent: string | null
  blocking: boolean
  retryCount: number
  createdAt: number
}

export interface ActiveTask {
  taskId: number
  requesterSessionId: string
  startedAt: number
}

export function isNewTaskReq(msg: MessageRow): boolean {
  return msg.task_id === msg.message_id
}

export function parsePayload(raw: string): MessagePayload | null {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.event === 'string' && typeof parsed.content === 'string') {
      return parsed as MessagePayload
    }
    return null
  } catch {
    return null
  }
}

export function createPayload(
  event: MessageEvent,
  content: string,
  options?: { intent?: string | null; need_reply?: boolean; detail?: string | null },
): MessagePayload {
  return {
    event,
    intent: options?.intent ?? null,
    need_reply: options?.need_reply ?? false,
    content,
    detail: options?.detail ?? null,
  }
}

/** Mint a session id with the `claude-` prefix so peers can tell Claude Code sessions apart. */
export function newClaudeSessionId(): string {
  return `claude-${crypto.randomUUID()}`
}
