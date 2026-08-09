// Per-server mutable state. The MCP server is a long-lived stdio process; one
// such process can join at most one channel at a time (mirrors pi-teammate).
// Every prompt handler reads/writes this object.

import type { Database } from 'bun:sqlite'
import type { Mamoru } from '../mamoru/mamoru.ts'
import type { MamoruConfig } from '../mamoru/types.ts'
import type { PersonaConfig } from './persona.ts'
import type { NotificationSender } from './channel-notifier.ts'

export interface ServerState {
  /** The host MCP server. Used to push notifications. */
  sender: NotificationSender
  /** cwd of the MCP subprocess at startup — usually Claude Code's project dir. */
  cwd: string
  /** Tuning overrides applied to every joined Mamoru (from env vars). */
  mamoruConfig: Partial<MamoruConfig>

  // Active session — null when not joined to any channel.
  channel: string | null
  db: Database | null
  mamoru: Mamoru | null
  persona: PersonaConfig | null
  /** The session id of the currently-joined agent (mirrors mamoru.sessionId). */
  sessionId: string | null
}

export function createState(opts: {
  sender: NotificationSender
  cwd: string
  persona?: PersonaConfig | null
  mamoruConfig?: Partial<MamoruConfig>
}): ServerState {
  return {
    sender: opts.sender,
    cwd: opts.cwd,
    mamoruConfig: opts.mamoruConfig ?? {},
    channel: null,
    db: null,
    mamoru: null,
    persona: opts.persona ?? null,
    sessionId: null,
  }
}

export function isJoined(state: ServerState): boolean {
  return state.mamoru !== null
}

/** Tear down the active MAMORU + DB. Safe to call when not joined. */
export function leaveActive(state: ServerState): void {
  if (state.mamoru) {
    try { state.mamoru.stop() } catch {}
    state.mamoru = null
  }
  if (state.db) {
    try { state.db.close() } catch {}
    state.db = null
  }
  state.channel = null
  state.sessionId = null
}
