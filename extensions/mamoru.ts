/**
 * MAMORU (守る, "to protect/guard") — background guardian process for pi-teammate.
 *
 * Polls SQLite for new messages, routes them (auto-handle or forward to LLM),
 * manages agent status and the in-memory roster, and tracks outbound tasks.
 */
import type Database from "better-sqlite3";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  MessageRow,
  MessagePayload,
  MamoruConfig,
  AgentStatus,
  ActiveTask,
  OutboundTask,
  PendingRetry,
  PersonaConfig,
} from "./types.ts";
import { parsePayload, createPayload, isNewTaskReq, MAX_CONTENT_WORDS } from "./types.ts";
import { sendTaskReq } from "./db.ts";
import {
  sendMessage,
  getUnreadMessages,
  advanceCursor,
  updateHeartbeat,
  updateAgentStatus,
  registerAgent,
  getAgentBySession,
  initCursor,
} from "./db.ts";
import { Roster } from "./roster.ts";

/** A single entry in the MAMORU event log. */
export interface MamoruEventLog {
  timestamp: number;
  direction: "recv" | "sent";
  event: string;
  otherParty: string;       // agent name of the other side
  taskId: number | null;
  content: string | null;
  forwardedToLlm: boolean;
}

export function broadcastAgentLeave(
  db: Database.Database,
  params: {
    sessionId: string;
    agentName: string;
    channel: string;
  },
): number {
  const leaveContent = `${params.agentName} has left the channel`;
  const leavePayload = createPayload("broadcast", leaveContent, {
    intent: "agent_leave",
  });
  return sendMessage(db, {
    from_agent: params.sessionId,
    to_agent: null,
    channel: params.channel,
    task_id: null,
    ref_message_id: null,
    payload: JSON.stringify(leavePayload),
  });
}

export class Mamoru {
  private db: Database.Database;
  private sessionId: string;
  private agentName: string;
  private channel: string;
  private persona: PersonaConfig | null;
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private roster: Roster;
  private config: MamoruConfig;
  private teammateDir: string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;
  private status: AgentStatus = "available";
  private activeTask: ActiveTask | null = null;
  private outboundTasks: Map<number, OutboundTask> = new Map();
  private contextBuffer: string[] = []; // buffered broadcast/info messages
  private eventLog: MamoruEventLog[] = [];
  private pendingRetries: Map<string, PendingRetry> = new Map(); // keyed by targetSessionId

  constructor(opts: {
    db: Database.Database;
    sessionId: string;
    agentName: string;
    channel: string;
    persona: PersonaConfig | null;
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    roster: Roster;
    config: MamoruConfig;
    teammateDir?: string;
  }) {
    this.db = opts.db;
    this.sessionId = opts.sessionId;
    this.agentName = opts.agentName;
    this.channel = opts.channel;
    this.persona = opts.persona;
    this.pi = opts.pi;
    this.ctx = opts.ctx;
    this.roster = opts.roster;
    this.config = opts.config;
    this.teammateDir = opts.teammateDir ?? "";
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Register agent, init cursor, broadcast agent_join, start polling. */
  start(): void {
    // Register self in DB
    registerAgent(this.db, {
      session_id: this.sessionId,
      agent_name: this.agentName,
      description: this.persona?.description ?? null,
      provider: this.persona?.provider ?? null,
      model: this.persona?.model ?? null,
      cwd: this.ctx.cwd ?? null,
    });

    // Init cursor
    initCursor(this.db, this.sessionId, this.channel);

    // Load roster from DB (excludes self)
    this.roster.initFromDb(this.db, this.sessionId);

    // Broadcast agent_join
    const joinContent = `${this.agentName} has joined the channel`;
    const joinPayload = createPayload("broadcast", joinContent, {
      intent: "agent_join",
    });
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: null,
      channel: this.channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(joinPayload),
    });
    this.logEvent("sent", "broadcast", "channel", null, joinContent, false);

    // Start polling
    this.startedAt = Date.now();
    this.pollTimer = setInterval(() => this.pollOnce(), this.config.pollIntervalMs);
  }

  /** Broadcast agent_leave, mark inactive, clear timer. */
  stop(): void {
    // Clear poll timer first
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Broadcast agent_leave
    const leaveContent = `${this.agentName} has left the channel`;
    broadcastAgentLeave(this.db, {
      sessionId: this.sessionId,
      agentName: this.agentName,
      channel: this.channel,
    });
    this.logEvent("sent", "broadcast", "channel", null, leaveContent, false);

    // Mark inactive in DB
    updateAgentStatus(this.db, this.sessionId, "inactive");
    this.status = "inactive";
    this.startedAt = null;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getActiveTask(): ActiveTask | null {
    return this.activeTask;
  }

  getOutboundTasks(): Map<number, OutboundTask> {
    return this.outboundTasks;
  }

  getRoster(): Roster {
    return this.roster;
  }

  getChannel(): string {
    return this.channel;
  }

  /** Whether MAMORU is actively polling. */
  isActive(): boolean {
    return this.startedAt !== null;
  }

  /** Uptime in milliseconds since start(), or 0 if inactive. */
  getUptimeMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  getAgentName(): string {
    return this.agentName;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Get this agent's detail directory for storing task output files. */
  getTeammateDir(): string {
    return this.teammateDir;
  }

  /** Get the content word limit from persona, or the default. */
  getContentWordLimit(): number {
    const custom = this.persona?.contentWordLimit;
    if (typeof custom === "number" && custom > 0) return custom;
    return MAX_CONTENT_WORDS;
  }

  /** Get the full event log (for the /mamoru overlay). */
  getEventLog(): MamoruEventLog[] {
    return this.eventLog;
  }

  /** Clear the in-memory event log. */
  clearEventLog(): void {
    this.eventLog = [];
  }

  /** Register an outbound task for timeout tracking. */
  registerOutboundTask(taskId: number, workerSessionId: string): void {
    this.outboundTasks.set(taskId, {
      taskId,
      workerSessionId,
      sentAt: Date.now(),
      lastEventAt: Date.now(),
      timeoutTimer: null,
    });
  }

  /** Register a task_req for auto-retry when the target agent becomes available. */
  registerPendingRetry(retry: PendingRetry): void {
    this.pendingRetries.set(retry.targetSessionId, retry);
  }

  /** Attempt to resend a pending retry. Returns the new task_id or null on failure. */
  private retryTask(retry: PendingRetry): number | null {
    try {
      const payload = createPayload("task_req", retry.content, {
        intent: retry.intent,
        need_reply: true,
        detail: retry.detail,
      });

      const messageId = sendTaskReq(this.db, {
        from_agent: this.sessionId,
        to_agent: retry.targetSessionId,
        channel: this.channel,
        payload: JSON.stringify(payload),
        maxContentWords: this.getContentWordLimit(),
      });

      this.registerOutboundTask(messageId, retry.targetSessionId);

      const targetName = this.getAgentDisplayName(retry.targetSessionId);
      this.logEvent("sent", "task_req", targetName, messageId, retry.content, false);

      return messageId;
    } catch {
      return null;
    }
  }

  /** Handle outbound status transitions (called by send_message tool). */
  handleOutbound(event: string, taskId?: number): void {
    if (event === "task_done" || event === "task_fail") {
      this.setStatus("available");
      this.activeTask = null;
    }
    // task_update, task_clarify → no status change
  }

  /** Build system prompt additions for before_agent_start hook. */
  buildSystemPromptAdditions(basePrompt: string): { systemPrompt: string } | undefined {
    let additions = "";

    if (this.persona) {
      additions += `\n\nYou are "${this.persona.name}"`;
      if (this.persona.systemPrompt) {
        additions += `\n\n${this.persona.systemPrompt}`;
      } else {
        additions += `\n\n${this.persona.description}`;
      }
    }

    if (this.teammateDir) {
      additions += `\n\nYour detail file directory: ${this.teammateDir}`;
      additions += `\nIMPORTANT — using the "detail" field in send_message:`;
      additions += `\n- When sending a task_req, you MUST include ALL context the recipient needs to complete the task. The "content" field is limited to ${this.getContentWordLimit()} words and is only a brief summary. Always put full details in the "detail" field (a markdown file path).`;
      additions += `\n- Write a markdown file to your detail directory (e.g. ${this.teammateDir}/task-brief.md) that contains the full task description, requirements, and references to any relevant files (images, code, screenshots, etc.) using their absolute paths.`;
      additions += `\n- Set the "detail" field to the absolute path of that markdown file.`;
      additions += `\n- For task_done/task_fail responses, also use a detail file to include full results, output files, or reports.`;
      additions += `\n- NEVER reference files, images, or attachments only in the "content" text — always put them in the detail file so the recipient can actually access them.`;
    }

    // Events MAMORU handles automatically — the LLM must not emit these
    additions += `\n\nEvents handled automatically by MAMORU (do NOT send these yourself):`;
    additions += `\n- task_ack: when you receive a task_req, MAMORU automatically replies with task_ack on your behalf. Do NOT send another task_ack — just start working on the task.`;
    additions += `\n- task_reject: automatically sent by MAMORU when you're busy.`;
    additions += `\n- task_cancel_ack: automatically sent by MAMORU when a task_cancel arrives.`;
    additions += `\n- ping / pong: heartbeat events handled by MAMORU.`;

    // Message content format rules (the "content" field is spoken aloud via TTS)
    additions += `\n\nMessage content format rules (max ${this.getContentWordLimit()} words, will be spoken aloud):`;
    additions += `\n- task_req: always start with the recipient's name. e.g. "Designer, please review the homepage layout"`;
    additions += `\n- task_update: always start with the recipient's name + "task status update". e.g. "Developer, task status update, styling fixes applied"`;
    additions += `\n- task_done: always start with the recipient's name. e.g. "Developer, code review complete, all good"`;
    additions += `\n- task_fail: always start with the recipient's name + "we are having a problem". e.g. "Developer, we are having a problem, build failed"`;
    additions += `\n- broadcast: always start with "Hi everyone". e.g. "Hi everyone, deployment is done"`;

    // Retry behavior
    additions += `\n\nTask retry behavior ("blocking" parameter in send_message for task_req):`;
    additions += `\n- blocking=true: if the recipient is busy, MAMORU will silently wait and auto-retry when they become available. Use this when you cannot proceed without the result.`;
    additions += `\n- blocking=false: if rejected, you are notified and can continue other work. MAMORU auto-retries when the recipient becomes available.`;
    additions += `\n- omitted: no auto-retry. You are notified of the rejection and must decide what to do.`;

    // Inject known teammates into system prompt (they may have joined before
    // us, so we missed their agent_join broadcasts due to cursor skip-to-MAX).
    const teammates = this.roster.getAll();
    if (teammates.length > 0) {
      const lines = teammates.map(e => `- "${e.agent_name}" (session: ${e.session_id}) — ${e.status} — ${e.description}`).join("\n");
      additions += `\n\nYour teammates on this channel:\n${lines}`;
    }

    if (this.activeTask) {
      const requesterName = this.getAgentDisplayName(this.activeTask.requesterSessionId);
      additions += `\n\nYou are currently working on a task (task #${this.activeTask.taskId}) requested by "${requesterName}" (session: ${this.activeTask.requesterSessionId}).`;
      additions += ` When done, use the send_message tool to report back with event "task_done" or "task_fail", setting to="${this.activeTask.requesterSessionId}" and task_id=${this.activeTask.taskId}.`;
      additions += `\n\nIMPORTANT — task_update frequency:`;
      additions += `\n- Send a "task_update" message after every important step or stage is finished (e.g. "plan drafted", "scaffold created", "API wired up", "tests passing", "refactor complete").`;
      additions += `\n- You MUST send multiple task_update messages between task_ack and task_done unless the task is trivial (< 1 minute of work).`;
      additions += `\n- Each update keeps the requester informed of progress, prevents timeout, and builds trust. A silent worker looks stuck even when it isn't.`;
      additions += `\n- Do NOT batch updates — send each one as soon as its milestone completes.`;
      additions += `\n- Keep the content brief (max ${this.getContentWordLimit()} words) and put any long details in the detail file.`;
    }

    if (additions) {
      return { systemPrompt: basePrompt + additions };
    }
    return undefined;
  }

  // ── Testable poll method ────────────────────────────────────────

  /** Execute one poll cycle. Public for testability. */
  pollOnce(): void {
    const messages = getUnreadMessages(this.db, this.sessionId, this.channel);

    if (messages.length > 0) {
      let lastId = 0;
      for (const msg of messages) {
        const payload = parsePayload(msg.payload);
        if (!payload) continue;

        this.processMessage(msg, payload);

        if (msg.message_id > lastId) {
          lastId = msg.message_id;
        }
      }

      if (lastId > 0) {
        advanceCursor(this.db, this.sessionId, this.channel, lastId);
      }
    }

    // Sync agent busy/idle status with the LLM state.
    this.syncIdleStatus();

    // Sync in-memory state with DB every poll cycle.
    this.refreshRosterStatuses();
  }

  /** Re-read agent statuses from the DB and update roster entries. */
  private refreshRosterStatuses(): void {
    let changed = false;
    for (const entry of this.roster.getAll()) {
      const agent = getAgentBySession(this.db, entry.session_id);
      if (!agent) {
        // Agent was removed from DB
        this.roster.remove(entry.session_id);
        changed = true;
      } else if (agent.status !== entry.status) {
        this.roster.update({
          ...entry,
          status: agent.status as AgentStatus,
        });
        changed = true;
      }
    }
    if (changed) {
      this.refreshSendMessageTool();
      this.processPendingRetries();
    }
  }

  /** Check pending retries and resend task_req if the target agent is now available. */
  private processPendingRetries(): void {
    for (const [targetSessionId, retry] of this.pendingRetries) {
      const entry = this.roster.get(targetSessionId);
      if (!entry || entry.status !== "available") continue;

      // Agent is available — retry!
      const newTaskId = this.retryTask(retry);
      if (newTaskId) {
        const targetName = this.getAgentDisplayName(targetSessionId);
        if (retry.blocking) {
          // Blocking: silent retry, no LLM notification needed
          this.logEvent("sent", "task_req", targetName, newTaskId,
            `[auto-retry #${retry.retryCount + 1}] ${retry.content}`, false);
        } else {
          // Non-blocking: tell the LLM the retry was sent
          this.pi.sendUserMessage(
            `[TEAM] "${targetName}" is now available. Auto-retried task_req (task #${newTaskId}): ${retry.content}`,
            { deliverAs: "steer" },
          );
        }
        this.pendingRetries.delete(targetSessionId);
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────

  private processMessage(msg: MessageRow, payload: MessagePayload): void {
    const fromName = this.getAgentDisplayName(msg.from_agent);

    switch (payload.event) {
      case "ping":
        this.logEvent("recv", "ping", fromName, msg.task_id, payload.content, false);
        this.autoReply(msg.from_agent, "pong", "pong", msg.task_id, msg.message_id);
        updateHeartbeat(this.db, this.sessionId);
        break;

      case "pong":
        this.logEvent("recv", "pong", fromName, msg.task_id, null, false);
        break;

      case "task_req":
        if (isNewTaskReq(msg)) {
          if (this.status === "available") {
            this.logEvent("recv", "task_req", fromName, msg.task_id, payload.content, true);
            this.autoReply(msg.from_agent, "task_ack", "accepted", msg.task_id, msg.message_id);
            this.setStatus("busy");
            this.activeTask = {
              taskId: msg.task_id!,
              requesterSessionId: msg.from_agent,
              startedAt: Date.now(),
            };
            this.forwardToLlm(msg, payload);
          } else {
            this.logEvent("recv", "task_req", fromName, msg.task_id, payload.content, false);
            this.autoReply(msg.from_agent, "task_reject", "busy", msg.task_id, msg.message_id);
          }
        } else {
          this.logEvent("recv", "task_req", fromName, msg.task_id, payload.content, true);
          this.forwardToLlm(msg, payload);
        }
        break;

      case "task_cancel":
        this.logEvent("recv", "task_cancel", fromName, msg.task_id, payload.content, false);
        this.autoReply(msg.from_agent, "task_cancel_ack", "cancelled", msg.task_id, msg.message_id);
        this.setStatus("available");
        this.activeTask = null;
        try {
          this.ctx.abort();
        } catch {
          // ignore abort errors
        }
        break;

      case "broadcast":
        this.logEvent("recv", "broadcast", fromName, msg.task_id, payload.content,
          payload.intent !== "agent_join" && payload.intent !== "agent_leave" && payload.intent !== "agent_status_change");
        if (payload.intent === "agent_join") {
          const agent = getAgentBySession(this.db, msg.from_agent);
          if (agent) {
            this.roster.update({
              session_id: agent.session_id,
              agent_name: agent.agent_name,
              description: agent.description ?? "(no description)",
              status: agent.status as AgentStatus,
              last_heartbeat: agent.last_heartbeat ?? Date.now(),
            });
            this.refreshSendMessageTool();
            this.ctx.ui.notify(`"${agent.agent_name}" joined the channel`, "info");
          }
        } else if (payload.intent === "agent_leave") {
          const leaveName = this.getAgentDisplayName(msg.from_agent);
          this.roster.remove(msg.from_agent);
          this.refreshSendMessageTool();
          this.ctx.ui.notify(`"${leaveName}" left the channel`, "info");
        } else if (payload.intent === "agent_status_change") {
          const agent = getAgentBySession(this.db, msg.from_agent);
          if (agent) {
            this.roster.update({
              session_id: agent.session_id,
              agent_name: agent.agent_name,
              description: agent.description ?? "",
              status: agent.status as AgentStatus,
              last_heartbeat: agent.last_heartbeat ?? Date.now(),
            });
            this.refreshSendMessageTool();
          }
        } else {
          this.contextBuffer.push(`[${payload.event}] ${payload.content}`);
          this.forwardToLlm(msg, payload);
        }
        break;

      case "info_only":
        this.logEvent("recv", "info_only", fromName, msg.task_id, payload.content, true);
        this.contextBuffer.push(`[info] ${payload.content}`);
        this.forwardToLlm(msg, payload);
        break;

      case "task_ack":
        this.logEvent("recv", "task_ack", fromName, msg.task_id, payload.content, false);
        // Task accepted — clear any pending retry for this agent
        this.pendingRetries.delete(msg.from_agent);
        break;

      case "task_cancel_ack":
        this.logEvent("recv", "task_cancel_ack", fromName, msg.task_id, payload.content, false);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        break;

      case "task_reject": {
        const pendingRetry = this.pendingRetries.get(msg.from_agent);
        if (pendingRetry) {
          // This task_req has retry tracking
          if (pendingRetry.blocking) {
            // Blocking: silently wait for the agent to become available (handled in refreshRosterStatuses)
            this.logEvent("recv", "task_reject", fromName, msg.task_id, payload.content, false);
            pendingRetry.retryCount++;
          } else {
            // Non-blocking: inform the LLM, keep the retry pending for when agent is available
            this.logEvent("recv", "task_reject", fromName, msg.task_id, payload.content, true);
            this.pi.sendUserMessage(
              `[TEAM] Task rejected by "${fromName}" (busy). The task is queued and will be auto-retried when they become available. You can continue with other work.`,
              { deliverAs: "steer" },
            );
          }
        } else {
          // No retry tracking — forward to LLM as before
          this.logEvent("recv", "task_reject", fromName, msg.task_id, payload.content, true);
          this.forwardToLlm(msg, payload);
        }
        // Remove the outbound task since it was rejected
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        break;
      }

      case "task_clarify":
        this.logEvent("recv", "task_clarify", fromName, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      case "task_clarify_res":
        this.logEvent("recv", "task_clarify_res", fromName, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      case "task_done":
        this.logEvent("recv", "task_done", fromName, msg.task_id, payload.content, true);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        this.forwardToLlm(msg, payload);
        break;

      case "task_fail":
        this.logEvent("recv", "task_fail", fromName, msg.task_id, payload.content, true);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        this.forwardToLlm(msg, payload);
        break;

      case "task_update":
        this.logEvent("recv", "task_update", fromName, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      default:
        this.logEvent("recv", payload.event, fromName, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;
    }
  }

  private forwardToLlm(msg: MessageRow, payload: MessagePayload): void {
    const fromName = this.getAgentDisplayName(msg.from_agent);
    const lines = [
      `[TEAM MESSAGE from "${fromName}" | event: ${payload.event} | task: #${msg.task_id ?? "none"} | ref: #${msg.ref_message_id ?? "none"}]`,
      payload.content,
    ];
    if (payload.detail) lines.push(`Detail file: ${payload.detail}`);
    const structured = lines.join("\n");
    this.pi.sendUserMessage(structured, { deliverAs: "steer" });
  }

  private setStatus(newStatus: AgentStatus): void {
    this.status = newStatus;
    updateAgentStatus(this.db, this.sessionId, newStatus);
  }

  /**
   * Sync MAMORU status with the LLM's idle state.
   * If the LLM is actively working (not idle), set status to "busy".
   * If the LLM is idle and there's no active task, set status to "available".
   */
  private syncIdleStatus(): void {
    try {
      const isIdle = this.ctx.isIdle();
      if (!isIdle && this.status === "available") {
        this.setStatus("busy");
      } else if (isIdle && this.status === "busy" && !this.activeTask) {
        this.setStatus("available");
      }
    } catch {
      // ctx.isIdle() may not be available in all contexts
    }
  }

  private autoReply(
    toAgent: string,
    event: string,
    content: string,
    taskId: number | null,
    refMessageId: number | null,
  ): void {
    this.logEvent("sent", event, this.getAgentDisplayName(toAgent), taskId, content, false);
    const payload = createPayload(event as any, content);
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: toAgent,
      channel: this.channel,
      task_id: taskId,
      ref_message_id: refMessageId,
      payload: JSON.stringify(payload),
    });
  }

  getAgentDisplayName(sessionId: string): string {
    // Check roster first
    const entry = this.roster.get(sessionId);
    if (entry) return entry.agent_name;

    // Fall back to DB lookup
    const agent = getAgentBySession(this.db, sessionId);
    if (agent) return agent.agent_name;

    return sessionId;
  }

  /** Log an outbound event from a tool (send_message). */
  logOutbound(event: string, otherParty: string, taskId: number | null, content: string | null): void {
    const displayParty = otherParty === "(broadcast)" || otherParty === "channel"
      ? otherParty
      : this.getAgentDisplayName(otherParty);
    this.logEvent("sent", event, displayParty, taskId, content, false);
  }

  private logEvent(
    direction: "recv" | "sent",
    event: string,
    otherParty: string,
    taskId: number | null,
    content: string | null,
    forwardedToLlm: boolean,
  ): void {
    const entry: MamoruEventLog = {
      timestamp: Date.now(),
      direction,
      event,
      otherParty,
      taskId,
      content,
      forwardedToLlm,
    };
    this.eventLog.push(entry);

    // Emit event so other extensions (e.g. TTS harness) can react immediately
    this.pi.events.emit("teammate_message", {
      ...entry,
      agentName: this.agentName,
    });
  }

  private refreshSendMessageTool(): void {
    this.pi.events.emit("teammate_roster_changed", {
      roster: this.roster,
      selfSessionId: this.sessionId,
    });
  }
}
