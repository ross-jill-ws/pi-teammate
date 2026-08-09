// MAMORU (守る, "to protect/guard") — poll loop + event router.
//
// Mirrors pi-teammate/extensions/mamoru.ts routing policy event-for-event,
// but decoupled from pi's ExtensionAPI. Outbound LLM pushes go through an
// injected Notifier (step 01 plugs in MCP); busy/idle sensing goes through an
// IdleDetector (Claude Code exposes none, so AlwaysIdle is the default).

import type { Database } from 'bun:sqlite'
import type {
  ActiveTask,
  AgentStatus,
  MamoruConfig,
  MessagePayload,
  MessageRow,
  OutboundTask,
  PendingRetry,
} from './types.ts'
import {
  DEFAULT_MAMORU_CONFIG,
  MAMORU_RESERVED_EVENTS,
  MAX_CONTENT_WORDS,
  MESSAGE_EVENTS,
  TASK_ID_REQUIRED_EVENTS,
  countWords,
  createPayload,
  isNewTaskReq,
  newClaudeSessionId,
  parsePayload,
} from './types.ts'
import type { MessageEvent } from './types.ts'
import {
  advanceCursor,
  getAgentBySession,
  getUnreadMessages,
  initCursor,
  registerAgent,
  sendMessage,
  sendTaskReq,
  updateAgentStatus,
  updateHeartbeat,
} from './db.ts'
import { Roster } from './roster.ts'
import { ConsoleNotifier, type Notifier } from './notifier.ts'
import { AlwaysIdle, type IdleDetector } from './idle.ts'

export interface MamoruOptions {
  db: Database
  channel: string
  sessionId?: string
  agentName: string
  description?: string
  cwd?: string
  notifier?: Notifier
  idle?: IdleDetector
  config?: Partial<MamoruConfig>
  onRosterChange?: () => void
}

export class Mamoru {
  readonly db: Database
  readonly channel: string
  readonly sessionId: string
  readonly agentName: string
  readonly description: string | null
  readonly cwd: string | null
  private readonly notifier: Notifier
  private readonly idle: IdleDetector
  private readonly config: MamoruConfig
  private readonly onRosterChange?: () => void

  private roster = new Roster()
  private status: AgentStatus = 'available'
  private activeTask: ActiveTask | null = null
  private outboundTasks = new Map<number, OutboundTask>()
  private pendingRetries = new Map<string, PendingRetry>() // keyed by targetSessionId
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastRosterSnapshot = ''

  constructor(opts: MamoruOptions) {
    this.db = opts.db
    this.channel = opts.channel
    this.sessionId = opts.sessionId ?? newClaudeSessionId()
    this.agentName = opts.agentName
    this.description = opts.description ?? null
    this.cwd = opts.cwd ?? null
    this.notifier = opts.notifier ?? new ConsoleNotifier()
    this.idle = opts.idle ?? new AlwaysIdle()
    this.config = { ...DEFAULT_MAMORU_CONFIG, ...opts.config }
    this.onRosterChange = opts.onRosterChange
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  start(): void {
    registerAgent(this.db, {
      session_id: this.sessionId,
      agent_name: this.agentName,
      description: this.description,
      provider: null,
      model: null,
      cwd: this.cwd,
    })
    initCursor(this.db, this.sessionId, this.channel)
    this.roster.initFromDb(this.db, this.sessionId)
    this.lastRosterSnapshot = this.roster.snapshot()

    const joinPayload = createPayload('broadcast', `${this.agentName} has joined the channel`, {
      intent: 'agent_join',
    })
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: null,
      channel: this.channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(joinPayload),
    })

    this.pollTimer = setInterval(() => this.pollOnce(), this.config.pollIntervalMs)
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    const leavePayload = createPayload('broadcast', `${this.agentName} has left the channel`, {
      intent: 'agent_leave',
    })
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: null,
      channel: this.channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(leavePayload),
    })
    updateAgentStatus(this.db, this.sessionId, 'inactive')
    this.status = 'inactive'
  }

  // ── Accessors (mostly for tests + step-01 MCP glue) ──────────────

  getStatus(): AgentStatus { return this.status }
  getActiveTask(): ActiveTask | null { return this.activeTask }
  getOutboundTasks(): ReadonlyMap<number, OutboundTask> { return this.outboundTasks }
  getPendingRetries(): ReadonlyMap<string, PendingRetry> { return this.pendingRetries }
  getRoster(): Roster { return this.roster }

  // ── Poll loop ────────────────────────────────────────────────────

  pollOnce(): void {
    const messages = getUnreadMessages(this.db, this.sessionId, this.channel)
    let lastId = 0
    for (const msg of messages) {
      const payload = parsePayload(msg.payload)
      if (!payload) continue
      this.processMessage(msg, payload)
      if (msg.message_id > lastId) lastId = msg.message_id
    }
    if (lastId > 0) advanceCursor(this.db, this.sessionId, this.channel, lastId)

    updateHeartbeat(this.db, this.sessionId)
    this.syncIdleStatus()
    this.refreshRosterFromDb()
    // processPendingRetries fires only on roster diff (inside refreshRosterFromDb),
    // mirroring pi-teammate. Running it every tick would race with task_reject
    // handling and retry before the peer's "busy" flag propagates.
  }

  // ── Consolidated outbound entry point (used by send-message-to-teammate) ─

  /**
   * One-stop outbound send. Enforces the full policy in one place so tool
   * handlers stay thin: validates the event, reserved-event rejection,
   * word limit, task_req preconditions, active-task auto-fill for replies,
   * and outbound/pending-retry bookkeeping.
   */
  send(opts: {
    to?: string | null
    event: MessageEvent
    taskId?: number | null
    refMessageId?: number | null
    content: string
    detail?: string | null
    intent?: string | null
    blocking?: boolean
  }): { messageId: number; taskId: number | null; resolvedTo: string | null } {
    if (!MESSAGE_EVENTS.includes(opts.event)) {
      throw new Error(`Unknown event: ${opts.event}`)
    }
    if (MAMORU_RESERVED_EVENTS.includes(opts.event)) {
      throw new Error(
        `Event "${opts.event}" is reserved — MAMORU sends it automatically in response to incoming traffic.`,
      )
    }

    const words = countWords(opts.content)
    if (words > this.config.contentWordLimit) {
      throw new Error(
        `content must be ≤ ${this.config.contentWordLimit} words (got ${words}). Put the rest in a detail markdown file and pass its path via 'detail'.`,
      )
    }

    if (opts.event === 'task_req') {
      const to = opts.to?.trim()
      if (!to) throw new Error('task_req requires "to"')
      if (to === this.sessionId) throw new Error('task_req cannot self-delegate')
      if (!this.roster.get(to)) {
        throw new Error(`No teammate with session_id "${to}" in the roster. Call get-team-roster first.`)
      }
      const id = this.sendTaskReq({
        to,
        content: opts.content,
        detail: opts.detail ?? null,
        intent: opts.intent ?? null,
        blocking: opts.blocking,
      })
      return { messageId: id, taskId: id, resolvedTo: to }
    }

    // Reply path — auto-fill to/task_id from the active inbound task when
    // the event requires a task id but the caller didn't set one.
    let to = opts.to?.trim() || null
    let taskId = opts.taskId ?? null
    if (TASK_ID_REQUIRED_EVENTS.includes(opts.event) && this.activeTask) {
      if (!to) to = this.activeTask.requesterSessionId
      if (taskId == null) taskId = this.activeTask.taskId
    }
    if (TASK_ID_REQUIRED_EVENTS.includes(opts.event) && taskId == null) {
      throw new Error(`Event "${opts.event}" requires a task_id (no active inbound task to default from).`)
    }

    const payload = createPayload(opts.event, opts.content, {
      intent: opts.intent ?? null,
      detail: opts.detail ?? null,
    })
    const id = sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: to,
      channel: this.channel,
      task_id: taskId,
      ref_message_id: opts.refMessageId ?? taskId,
      payload: JSON.stringify(payload),
    })

    // Bookkeeping for outbound task-scoped events.
    if (taskId != null) {
      const outbound = this.outboundTasks.get(taskId)
      if (outbound) outbound.lastEventAt = Date.now()
    }
    // Worker-side lifecycle: task_done / task_fail flip local status.
    if (opts.event === 'task_done' || opts.event === 'task_fail') {
      if (this.activeTask && taskId === this.activeTask.taskId) {
        this.setStatus('available')
        this.activeTask = null
      }
    }
    // task_cancel (requester-side): leave outbound in place; it clears on
    // task_cancel_ack arrival.

    return { messageId: id, taskId, resolvedTo: to }
  }

  // ── Outbound (used by send_message tool in step 02) ──────────────

  /**
   * Worker-side report back to requester. Also flips local busy→available when
   * reporting task_done / task_fail.
   */
  sendReply(opts: {
    to: string
    event: MessagePayload['event']
    taskId: number
    content: string
    detail?: string | null
    intent?: string | null
  }): number {
    const payload = createPayload(opts.event, opts.content, {
      intent: opts.intent ?? null,
      detail: opts.detail ?? null,
    })
    const id = sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: opts.to,
      channel: this.channel,
      task_id: opts.taskId,
      ref_message_id: opts.taskId,
      payload: JSON.stringify(payload),
    })
    if (opts.event === 'task_done' || opts.event === 'task_fail') {
      this.setStatus('available')
      this.activeTask = null
    }
    return id
  }

  /**
   * Requester-side new task. Self-referencing task_id is set by sendTaskReq.
   * Registers an outbound task for tracking and, if `blocking` provided, a
   * PendingRetry entry so MAMORU will resend once the target becomes available.
   */
  sendTaskReq(opts: {
    to: string
    content: string
    detail?: string | null
    intent?: string | null
    blocking?: boolean
  }): number {
    const payload = createPayload('task_req', opts.content, {
      intent: opts.intent ?? null,
      need_reply: true,
      detail: opts.detail ?? null,
    })
    const id = sendTaskReq(this.db, {
      from_agent: this.sessionId,
      to_agent: opts.to,
      channel: this.channel,
      payload: JSON.stringify(payload),
    })
    this.outboundTasks.set(id, {
      taskId: id,
      workerSessionId: opts.to,
      sentAt: Date.now(),
      lastEventAt: Date.now(),
    })
    if (opts.blocking !== undefined) {
      this.pendingRetries.set(opts.to, {
        targetSessionId: opts.to,
        content: opts.content,
        detail: opts.detail ?? null,
        intent: opts.intent ?? null,
        blocking: opts.blocking,
        retryCount: 0,
        createdAt: Date.now(),
      })
    }
    return id
  }

  /** Broadcast to the channel (no recipient). */
  sendBroadcast(content: string, intent: string | null = null, detail: string | null = null): number {
    const payload = createPayload('broadcast', content, { intent, detail })
    return sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: null,
      channel: this.channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(payload),
    })
  }

  // ── Internal routing (policy mirrors pi-teammate) ────────────────

  private processMessage(msg: MessageRow, payload: MessagePayload): void {
    switch (payload.event) {
      case 'ping':
        this.autoReply(msg.from_agent, 'pong', 'pong', msg.task_id, msg.message_id)
        updateHeartbeat(this.db, this.sessionId)
        return

      case 'pong':
        return

      case 'task_req':
        if (isNewTaskReq(msg)) {
          if (this.status === 'available') {
            this.autoReply(msg.from_agent, 'task_ack', 'accepted', msg.task_id, msg.message_id)
            this.setStatus('busy')
            this.activeTask = {
              taskId: msg.task_id!,
              requesterSessionId: msg.from_agent,
              startedAt: Date.now(),
            }
            this.forwardToLlm(msg, payload)
          } else {
            this.autoReply(msg.from_agent, 'task_reject', 'busy', msg.task_id, msg.message_id)
          }
        } else {
          // Follow-up on an existing task thread (e.g. the requester sending
          // additional info under the same task_id). Forward, don't ack.
          this.forwardToLlm(msg, payload)
        }
        return

      case 'task_ack':
        // Target accepted — drop any pending retry we had queued for them.
        this.pendingRetries.delete(msg.from_agent)
        return

      case 'task_reject': {
        const retry = this.pendingRetries.get(msg.from_agent)
        if (retry) {
          if (retry.blocking) {
            retry.retryCount++  // silent, wait for roster availability
          } else {
            const targetName = this.getAgentDisplayName(msg.from_agent)
            this.notifier.steer(
              `[TEAM] Task rejected by "${targetName}" (busy). The task is queued and will be auto-retried when they become available.`,
              { event: 'task_reject', from: msg.from_agent, task_id: String(msg.task_id ?? '') },
            )
          }
        } else {
          this.forwardToLlm(msg, payload)
        }
        if (msg.task_id) this.outboundTasks.delete(msg.task_id)
        return
      }

      case 'task_clarify':
      case 'task_clarify_res':
      case 'task_update':
        this.forwardToLlm(msg, payload)
        return

      case 'task_done':
      case 'task_fail':
        if (msg.task_id) this.outboundTasks.delete(msg.task_id)
        this.forwardToLlm(msg, payload)
        return

      case 'task_cancel':
        this.autoReply(msg.from_agent, 'task_cancel_ack', 'cancelled', msg.task_id, msg.message_id)
        this.setStatus('available')
        this.activeTask = null
        this.forwardToLlm(msg, payload)
        return

      case 'task_cancel_ack':
        if (msg.task_id) this.outboundTasks.delete(msg.task_id)
        return

      case 'broadcast':
        if (payload.intent === 'agent_join') {
          const agent = getAgentBySession(this.db, msg.from_agent)
          if (agent) {
            this.roster.update({
              session_id: agent.session_id,
              agent_name: agent.agent_name,
              description: agent.description ?? '',
              status: agent.status,
              last_heartbeat: agent.last_heartbeat ?? Date.now(),
            })
          }
          // Surface roster-change to the LLM too — Claude Code has no out-of-band
          // join notification, so the channel event IS the notification.
          this.notifier.steer(`[TEAM] "${msg.from_agent}" joined the channel`, {
            event: 'agent_join',
            from: msg.from_agent,
          })
        } else if (payload.intent === 'agent_leave') {
          const leaveName = this.getAgentDisplayName(msg.from_agent)
          this.roster.remove(msg.from_agent)
          this.notifier.steer(`[TEAM] "${leaveName}" left the channel`, {
            event: 'agent_leave',
            from: msg.from_agent,
          })
        } else if (payload.intent === 'agent_status_change') {
          const agent = getAgentBySession(this.db, msg.from_agent)
          if (agent) {
            this.roster.update({
              session_id: agent.session_id,
              agent_name: agent.agent_name,
              description: agent.description ?? '',
              status: agent.status,
              last_heartbeat: agent.last_heartbeat ?? Date.now(),
            })
          }
        } else {
          this.forwardToLlm(msg, payload)
        }
        return

      case 'info_only':
        this.forwardToLlm(msg, payload)
        return

      default:
        this.forwardToLlm(msg, payload)
    }
  }

  private forwardToLlm(msg: MessageRow, payload: MessagePayload): void {
    const fromName = this.getAgentDisplayName(msg.from_agent)
    const lines = [
      `[TEAM MESSAGE from "${fromName}" | event: ${payload.event} | task: #${msg.task_id ?? 'none'} | ref: #${msg.ref_message_id ?? 'none'}]`,
      payload.content,
    ]
    if (payload.detail) lines.push(`Detail file: ${payload.detail}`)
    this.notifier.steer(lines.join('\n'), {
      event: payload.event,
      from: msg.from_agent,
      task_id: String(msg.task_id ?? ''),
      message_id: String(msg.message_id),
      channel: this.channel,
    })
  }

  private autoReply(
    toAgent: string,
    event: MessagePayload['event'],
    content: string,
    taskId: number | null,
    refMessageId: number | null,
  ): void {
    const payload = createPayload(event, content)
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: toAgent,
      channel: this.channel,
      task_id: taskId,
      ref_message_id: refMessageId,
      payload: JSON.stringify(payload),
    })
  }

  private setStatus(newStatus: AgentStatus): void {
    this.status = newStatus
    updateAgentStatus(this.db, this.sessionId, newStatus)
  }

  private syncIdleStatus(): void {
    const isIdle = this.idle.isIdle()
    if (!isIdle && this.status === 'available') {
      this.setStatus('busy')
    } else if (isIdle && this.status === 'busy' && !this.activeTask) {
      this.setStatus('available')
    }
  }

  private refreshRosterFromDb(): void {
    // Walk existing roster entries only (same policy as pi-teammate): pull
    // status + heartbeat updates from the DB; drop rows that have disappeared.
    // Do NOT re-read all agents from the DB here — that would undo
    // agent_leave removals and resurrect peers we've decided are gone.
    for (const entry of this.roster.getAll()) {
      const agent = getAgentBySession(this.db, entry.session_id)
      if (!agent) {
        this.roster.remove(entry.session_id)
        continue
      }
      if (agent.status !== entry.status || (agent.last_heartbeat ?? 0) !== entry.last_heartbeat) {
        this.roster.update({
          session_id: entry.session_id,
          agent_name: agent.agent_name,
          description: agent.description ?? entry.description,
          status: agent.status,
          last_heartbeat: agent.last_heartbeat ?? entry.last_heartbeat,
        })
      }
    }
    this.roster.markStale(this.config.staleHeartbeatMs)
    const snap = this.roster.snapshot()
    if (snap !== this.lastRosterSnapshot) {
      this.lastRosterSnapshot = snap
      this.onRosterChange?.()
      this.processPendingRetries()
    }
  }

  private processPendingRetries(): void {
    for (const [targetSessionId, retry] of this.pendingRetries) {
      const entry = this.roster.get(targetSessionId)
      if (!entry || entry.status !== 'available') continue
      const newTaskId = this.retryTask(retry)
      if (newTaskId != null) {
        if (!retry.blocking) {
          const targetName = this.getAgentDisplayName(targetSessionId)
          this.notifier.steer(
            `[TEAM] "${targetName}" is now available. Auto-retried task_req (task #${newTaskId}): ${retry.content}`,
            { event: 'task_req_retry', to: targetSessionId, task_id: String(newTaskId) },
          )
        }
        this.pendingRetries.delete(targetSessionId)
      }
    }
  }

  private retryTask(retry: PendingRetry): number | null {
    try {
      const payload = createPayload('task_req', retry.content, {
        intent: retry.intent,
        need_reply: true,
        detail: retry.detail,
      })
      const id = sendTaskReq(this.db, {
        from_agent: this.sessionId,
        to_agent: retry.targetSessionId,
        channel: this.channel,
        payload: JSON.stringify(payload),
        maxContentWords: MAX_CONTENT_WORDS,
      })
      this.outboundTasks.set(id, {
        taskId: id,
        workerSessionId: retry.targetSessionId,
        sentAt: Date.now(),
        lastEventAt: Date.now(),
      })
      return id
    } catch {
      return null
    }
  }

  private getAgentDisplayName(sessionId: string): string {
    const entry = this.roster.get(sessionId)
    if (entry) return entry.agent_name
    const agent = getAgentBySession(this.db, sessionId)
    if (agent) return agent.agent_name
    return sessionId
  }
}
