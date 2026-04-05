import type { RosterEntry, AgentStatus, AgentRow } from "./types.ts";
import type Database from "better-sqlite3";

export class Roster {
  private entries: Map<string, RosterEntry> = new Map(); // keyed by session_id

  /** Populate roster from agents table (call on startup). Excludes self. */
  initFromDb(db: Database.Database, selfSessionId: string): void {
    const rows = db
      .prepare("SELECT session_id, agent_name, description, status, last_heartbeat FROM agents WHERE session_id != @selfSessionId")
      .all({ selfSessionId }) as AgentRow[];

    this.entries.clear();
    for (const row of rows) {
      this.entries.set(row.session_id, {
        session_id: row.session_id,
        agent_name: row.agent_name,
        description: row.description ?? "",
        status: row.status,
        last_heartbeat: row.last_heartbeat ?? 0,
      });
    }
  }

  /** Add or update a roster entry */
  update(entry: RosterEntry): void {
    this.entries.set(entry.session_id, entry);
  }

  /** Clear all roster entries */
  clear(): void {
    this.entries.clear();
  }

  /** Remove an agent from the roster */
  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Mark an agent as inactive */
  markInactive(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      entry.status = "inactive";
    }
  }

  /** Get all roster entries */
  getAll(): RosterEntry[] {
    return [...this.entries.values()];
  }

  /** Get only available agents */
  getAvailable(): RosterEntry[] {
    return [...this.entries.values()].filter((e) => e.status === "available");
  }

  /** Get a specific entry */
  get(sessionId: string): RosterEntry | undefined {
    return this.entries.get(sessionId);
  }

  /** Build the dynamic description for the send_message tool. Excludes self. */
  buildToolDescription(selfSessionId: string): string {
    const teammates = [...this.entries.values()].filter(
      (e) => e.session_id !== selfSessionId,
    );

    if (teammates.length === 0) {
      return (
        "Send a message to a teammate or broadcast to the team. " +
        "Use event 'task_req' to request work or ask a question (expects a response). " +
        "Use task_done/task_fail/task_update/task_clarify for task lifecycle. " +
        "Use broadcast/info_only for announcements (no response expected). " +
        "No teammates are currently online."
      );
    }

    const lines = teammates.map(
      (e) =>
        `  - "${e.agent_name}" (session: ${e.session_id}) — ${e.status} — ${e.description}`,
    );

    return [
      "Send a message to a teammate or broadcast to the team.",
      "Use event 'task_req' to request work or ask a question (expects a response).",
      "Use task_done/task_fail/task_update/task_clarify for task lifecycle.",
      "Use broadcast/info_only for announcements (no response expected).",
      "",
      "Available teammates:",
      ...lines,
      "",
      "To request work or ask a question, use event 'task_req' with a 'to' recipient.",
      "Pick an 'available' agent whose description matches the request.",
      "If no suitable agent is available, report that to the user.",
    ].join("\n");
  }
}
