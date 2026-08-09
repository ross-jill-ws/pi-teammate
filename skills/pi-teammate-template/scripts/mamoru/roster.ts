// In-memory roster with diff detection for firing onRosterChange callbacks.
// Mirrors pi-teammate/extensions/roster.ts (add/update/remove/get/getAll) and
// adds a `snapshot()`/`diff()` pair so MAMORU can detect "anything changed
// since last tick?" without any pi-specific event bus.

import type { Database } from 'bun:sqlite'
import type { AgentRow, AgentStatus, RosterEntry } from './types.ts'

export class Roster {
  private entries = new Map<string, RosterEntry>()

  initFromDb(db: Database, selfSessionId: string): void {
    const rows = db.prepare(`
      SELECT session_id, agent_name, description, status, last_heartbeat
      FROM agents
      WHERE session_id != @selfSessionId AND status != 'inactive'
    `).all({ selfSessionId }) as AgentRow[]

    this.entries.clear()
    for (const row of rows) {
      this.entries.set(row.session_id, {
        session_id: row.session_id,
        agent_name: row.agent_name,
        description: row.description ?? '',
        status: row.status,
        last_heartbeat: row.last_heartbeat ?? 0,
      })
    }
  }

  update(entry: RosterEntry): void {
    this.entries.set(entry.session_id, entry)
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  markInactive(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry) entry.status = 'inactive'
  }

  get(sessionId: string): RosterEntry | undefined {
    return this.entries.get(sessionId)
  }

  getAll(): RosterEntry[] {
    return [...this.entries.values()]
  }

  getAvailable(): RosterEntry[] {
    return [...this.entries.values()].filter(e => e.status === 'available')
  }

  clear(): void {
    this.entries.clear()
  }

  /** Compact string snapshot of (session_id → status) for diff detection. */
  snapshot(): string {
    const ordered = [...this.entries.values()]
      .sort((a, b) => a.session_id.localeCompare(b.session_id))
      .map(e => `${e.session_id}:${e.status}`)
    return ordered.join('|')
  }

  /** True if the current snapshot differs from `prev`. */
  diff(prev: string): boolean {
    return this.snapshot() !== prev
  }

  /** Flip to 'inactive' any entry whose heartbeat is older than thresholdMs. */
  markStale(thresholdMs: number, now = Date.now()): string[] {
    const staled: string[] = []
    for (const e of this.entries.values()) {
      if (e.status !== 'inactive' && now - e.last_heartbeat > thresholdMs) {
        e.status = 'inactive'
        staled.push(e.session_id)
      }
    }
    return staled
  }
}

export type { AgentStatus, RosterEntry }
