// Filesystem layout for pi-teammate channels. Mirrors
// pi-teammate/extensions/paths.ts so Claude Code agents live in the same
// directory tree as pi agents and can share channels.
//
//   ~/.pi/pi-teammate/<channel>/team.db
//   ~/.pi/pi-teammate/<channel>/<session_id>/   (detail files for that agent)

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

export function baseDir(): string {
  // Prefer $HOME so tests can override, fall back to os.homedir() which caches
  // at process start and ignores runtime env changes.
  const home = process.env.HOME ?? homedir()
  return join(home, '.pi', 'pi-teammate')
}

export function getChannelDir(channel: string): string {
  return join(baseDir(), channel)
}

export function getDbPath(channel: string): string {
  return join(getChannelDir(channel), 'team.db')
}

/** Returns the detail-file dir for a teammate. Creates it (recursive) if absent. */
export function getTeammateDir(channel: string, teammateSessionId: string): string {
  const dir = join(getChannelDir(channel), teammateSessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function channelExists(channel: string): boolean {
  return existsSync(getDbPath(channel))
}
