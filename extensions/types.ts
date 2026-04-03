/**
 * Shared TypeScript types for pi-teammate.
 */

// ── Agent Status ────────────────────────────────────────────────
export type AgentStatus = "available" | "busy" | "inactive";

// ── Message Event Types ─────────────────────────────────────────
export type MessageEvent =
  | "broadcast"
  | "info_only"
  | "ping"
  | "pong"
  | "task_req"
  | "task_ack"
  | "task_reject"
  | "task_clarify"
  | "task_clarify_res"
  | "task_update"
  | "task_done"
  | "task_fail"
  | "task_cancel"
  | "task_cancel_ack";

export const MESSAGE_EVENTS: readonly MessageEvent[] = [
  "broadcast", "info_only",
  "ping", "pong",
  "task_req", "task_ack", "task_reject",
  "task_clarify", "task_clarify_res",
  "task_update", "task_done", "task_fail",
  "task_cancel", "task_cancel_ack",
] as const;

export const TASK_EVENTS: readonly MessageEvent[] = [
  "task_req", "task_ack", "task_reject",
  "task_clarify", "task_clarify_res",
  "task_update", "task_done", "task_fail",
  "task_cancel", "task_cancel_ack",
] as const;

// Events that require task_id
export const TASK_ID_REQUIRED_EVENTS: readonly MessageEvent[] = [
  "task_ack", "task_reject",
  "task_clarify", "task_clarify_res",
  "task_update", "task_done", "task_fail",
  "task_cancel", "task_cancel_ack",
] as const;

// ── Payload JSON Structure ──────────────────────────────────────
export interface MessagePayload {
  event: MessageEvent;
  intent: string | null;
  need_reply: boolean;
  content: string; // max 500 chars
  detail: string | null; // absolute file path or null
}

export const MAX_CONTENT_LENGTH = 500;

// ── DB Row Types ────────────────────────────────────────────────
export interface AgentRow {
  session_id: string;
  agent_name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  status: AgentStatus;
  last_heartbeat: number | null;
}

export interface MessageRow {
  message_id: number;
  from_agent: string;
  to_agent: string | null;
  channel: string;
  task_id: number | null;
  ref_message_id: number | null;
  payload: string; // JSON string
  created_at: number;
}

export interface CursorRow {
  session_id: string;
  channel: string;
  last_read_id: number;
}

// ── Persona Config ──────────────────────────────────────────────
export interface PersonaConfig {
  name: string;
  provider: string | null;
  model: string | null;
  description: string;
}

// ── Roster Entry (in-memory) ────────────────────────────────────
export interface RosterEntry {
  session_id: string;
  agent_name: string;
  description: string;
  status: AgentStatus;
  last_heartbeat: number;
}

// ── MAMORU Config ───────────────────────────────────────────────
export interface MamoruConfig {
  pollIntervalMs: number; // default 1000
  taskTimeoutMinutes: number; // default 20
  pingTimeoutSeconds: number; // default 20
}

export const DEFAULT_MAMORU_CONFIG: MamoruConfig = {
  pollIntervalMs: 1000,
  taskTimeoutMinutes: 20,
  pingTimeoutSeconds: 20,
};

// ── Outbound Task Tracking (requester side) ─────────────────────
export interface OutboundTask {
  taskId: number;
  workerSessionId: string;
  sentAt: number;
  lastEventAt: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

// ── Active Task (worker side) ───────────────────────────────────
export interface ActiveTask {
  taskId: number;
  requesterSessionId: string;
  startedAt: number;
}

// ── Helper: check if a message is a new task_req ────────────────
export function isNewTaskReq(msg: MessageRow): boolean {
  return msg.task_id === msg.message_id;
}

// ── Helper: parse payload safely ────────────────────────────────
export function parsePayload(raw: string): MessagePayload | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.event === "string" && typeof parsed.content === "string") {
      return parsed as MessagePayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Helper: create a payload ────────────────────────────────────
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
  };
}
