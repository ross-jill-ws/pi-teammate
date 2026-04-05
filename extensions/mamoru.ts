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
  PersonaConfig,
} from "./types.ts";
import { parsePayload, createPayload, isNewTaskReq, MAX_CONTENT_WORDS } from "./types.ts";
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
  private status: AgentStatus = "available";
  private activeTask: ActiveTask | null = null;
  private outboundTasks: Map<number, OutboundTask> = new Map();
  private contextBuffer: string[] = []; // buffered broadcast/info messages
  private eventLog: MamoruEventLog[] = [];

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
    const leavePayload = createPayload("broadcast", leaveContent, {
      intent: "agent_leave",
    });
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: null,
      channel: this.channel,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(leavePayload),
    });
    this.logEvent("sent", "broadcast", "channel", null, leaveContent, false);

    // Mark inactive in DB
    updateAgentStatus(this.db, this.sessionId, "inactive");
    this.status = "inactive";
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

    // Message content format rules (the "content" field is spoken aloud via TTS)
    additions += `\n\nMessage content format rules (max ${this.getContentWordLimit()} words, will be spoken aloud):`;
    additions += `\n- task_req: always start with the recipient's name. e.g. "Designer, please review the homepage layout"`;
    additions += `\n- task_ack: just say "acknowledged" or "roger"`;
    additions += `\n- task_update: always start with the recipient's name + "task status update". e.g. "Developer, task status update, styling fixes applied"`;
    additions += `\n- task_done: always start with the recipient's name. e.g. "Developer, code review complete, all good"`;
    additions += `\n- task_fail: always start with the recipient's name + "we are having a problem". e.g. "Developer, we are having a problem, build failed"`;
    additions += `\n- broadcast: always start with "Hi everyone". e.g. "Hi everyone, deployment is done"`;

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
      additions += `\nSend periodic "task_update" messages to prevent timeout.`;
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

    // Sync in-memory state with DB every poll cycle.
    this.refreshRosterStatuses();
    this.checkDbCleared();
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
    }
  }

  /** If messages table is empty, clear in-memory state to match. */
  private checkDbCleared(): void {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE channel = ?"
    ).get(this.channel) as { cnt: number };

    if (row.cnt === 0 && (this.eventLog.length > 0 || this.activeTask || this.outboundTasks.size > 0)) {
      this.eventLog = [];
      this.activeTask = null;
      this.outboundTasks.clear();
      this.contextBuffer = [];
      this.status = "available";
      updateAgentStatus(this.db, this.sessionId, "available");
    }
  }

  // ── Internal ────────────────────────────────────────────────────

  private processMessage(msg: MessageRow, payload: MessagePayload): void {
    switch (payload.event) {
      case "ping":
        this.logEvent("recv", "ping", msg.from_agent, msg.task_id, payload.content, false);
        this.autoReply(msg.from_agent, "pong", "pong", msg.task_id, msg.message_id);
        updateHeartbeat(this.db, this.sessionId);
        break;

      case "pong":
        this.logEvent("recv", "pong", msg.from_agent, msg.task_id, null, false);
        break;

      case "task_req":
        if (isNewTaskReq(msg)) {
          if (this.status === "available") {
            this.logEvent("recv", "task_req", msg.from_agent, msg.task_id, payload.content, true);
            this.autoReply(msg.from_agent, "task_ack", "accepted", msg.task_id, msg.message_id);
            this.setStatus("busy");
            this.activeTask = {
              taskId: msg.task_id!,
              requesterSessionId: msg.from_agent,
              startedAt: Date.now(),
            };
            this.forwardToLlm(msg, payload);
          } else {
            this.logEvent("recv", "task_req", msg.from_agent, msg.task_id, payload.content, false);
            this.autoReply(msg.from_agent, "task_reject", "busy", msg.task_id, msg.message_id);
          }
        } else {
          this.logEvent("recv", "task_req", msg.from_agent, msg.task_id, payload.content, true);
          this.forwardToLlm(msg, payload);
        }
        break;

      case "task_cancel":
        this.logEvent("recv", "task_cancel", msg.from_agent, msg.task_id, payload.content, false);
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
        this.logEvent("recv", "broadcast", msg.from_agent, msg.task_id, payload.content,
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
          }
        } else if (payload.intent === "agent_leave") {
          this.roster.remove(msg.from_agent);
          this.refreshSendMessageTool();
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
        this.logEvent("recv", "info_only", msg.from_agent, msg.task_id, payload.content, true);
        this.contextBuffer.push(`[info] ${payload.content}`);
        this.forwardToLlm(msg, payload);
        break;

      case "task_ack":
        this.logEvent("recv", "task_ack", msg.from_agent, msg.task_id, payload.content, false);
        break;

      case "task_cancel_ack":
        this.logEvent("recv", "task_cancel_ack", msg.from_agent, msg.task_id, payload.content, false);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        break;

      case "task_reject":
        this.logEvent("recv", "task_reject", msg.from_agent, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      case "task_clarify":
        this.logEvent("recv", "task_clarify", msg.from_agent, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      case "task_clarify_res":
        this.logEvent("recv", "task_clarify_res", msg.from_agent, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      case "task_done":
        this.logEvent("recv", "task_done", msg.from_agent, msg.task_id, payload.content, true);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        this.forwardToLlm(msg, payload);
        break;

      case "task_fail":
        this.logEvent("recv", "task_fail", msg.from_agent, msg.task_id, payload.content, true);
        if (msg.task_id) {
          this.outboundTasks.delete(msg.task_id);
        }
        this.forwardToLlm(msg, payload);
        break;

      case "task_update":
        this.logEvent("recv", "task_update", msg.from_agent, msg.task_id, payload.content, true);
        this.forwardToLlm(msg, payload);
        break;

      default:
        this.logEvent("recv", payload.event, msg.from_agent, msg.task_id, payload.content, true);
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

  private getAgentDisplayName(sessionId: string): string {
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
    this.logEvent("sent", event, otherParty, taskId, content, false);
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
