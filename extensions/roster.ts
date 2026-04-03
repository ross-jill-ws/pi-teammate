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

  /** Build the dynamic description for the delegate_task tool. Excludes self. */
  buildToolDescription(selfSessionId: string): string {
    const teammates = [...this.entries.values()].filter(
      (e) => e.session_id !== selfSessionId,
    );

    if (teammates.length === 0) {
      return "Assign a task to a teammate. No teammates are currently online.";
    }

    const lines = teammates.map(
      (e) =>
        `  - "${e.agent_name}" (session: ${e.session_id}) — ${e.status} — ${e.description}`,
    );

    return [
      "Assign a task to a teammate.",
      "",
      "Available teammates:",
      ...lines,
      "",
      "Pick an 'available' agent whose description matches the task.",
      "If no suitable agent is available, report that to the user.",
    ].join("\n");
  }
}
