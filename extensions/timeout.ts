import type Database from "better-sqlite3";
import type { OutboundTask, MamoruConfig } from "./types.ts";
import { sendMessage, updateAgentStatus } from "./db.ts";
import { createPayload } from "./types.ts";

export class TimeoutManager {
  private config: MamoruConfig;
  private outboundTasks: Map<number, OutboundTask>;
  private db: Database.Database;
  private sessionId: string;
  private channel: string;
  private onTimeout: (taskId: number, workerSessionId: string) => void;

  constructor(opts: {
    config: MamoruConfig;
    outboundTasks: Map<number, OutboundTask>;
    db: Database.Database;
    sessionId: string;
    channel: string;
    onTimeout: (taskId: number, workerSessionId: string) => void;
  }) {
    this.config = opts.config;
    this.outboundTasks = opts.outboundTasks;
    this.db = opts.db;
    this.sessionId = opts.sessionId;
    this.channel = opts.channel;
    this.onTimeout = opts.onTimeout;
  }

  startTracking(taskId: number, workerSessionId: string): void {
    this.stopTracking(taskId); // clear any existing
    const now = Date.now();
    const timeoutMs = this.config.taskTimeoutMinutes * 60 * 1000;
    const timer = setTimeout(() => this.handleTimeout(taskId), timeoutMs);
    this.outboundTasks.set(taskId, {
      taskId,
      workerSessionId,
      sentAt: now,
      lastEventAt: now,
      timeoutTimer: timer,
    });
  }

  resetTimer(taskId: number): void {
    const task = this.outboundTasks.get(taskId);
    if (!task) return;
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    task.lastEventAt = Date.now();
    const timeoutMs = this.config.taskTimeoutMinutes * 60 * 1000;
    task.timeoutTimer = setTimeout(() => this.handleTimeout(taskId), timeoutMs);
  }

  stopTracking(taskId: number): void {
    const task = this.outboundTasks.get(taskId);
    if (!task) return;
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    this.outboundTasks.delete(taskId);
  }

  clearAll(): void {
    for (const [, task] of this.outboundTasks) {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    }
    this.outboundTasks.clear();
  }

  isTracking(taskId: number): boolean {
    return this.outboundTasks.has(taskId);
  }

  private handleTimeout(taskId: number): void {
    const task = this.outboundTasks.get(taskId);
    if (!task) return;

    // Send task_cancel with intent=task_timeout
    const payload = createPayload("task_cancel", `Task timed out after ${this.config.taskTimeoutMinutes} minutes with no updates.`, {
      intent: "task_timeout",
      need_reply: true,
    });

    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: task.workerSessionId,
      channel: this.channel,
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(payload),
    });

    // Start secondary timer — if no task_cancel_ack, mark worker inactive
    task.timeoutTimer = setTimeout(() => {
      if (this.outboundTasks.has(taskId)) {
        // No ack received — mark worker inactive
        try { updateAgentStatus(this.db, task.workerSessionId, "inactive"); } catch {}
        this.outboundTasks.delete(taskId);
        this.onTimeout(taskId, task.workerSessionId);
      }
    }, this.config.pingTimeoutSeconds * 1000);
  }
}
