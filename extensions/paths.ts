/**
 * Path helpers for pi-teammate.
 *
 * Directory layout:
 *   ~/.pi/pi-teammate/<channel>/team.db
 *   ~/.pi/pi-teammate/<channel>/<teammate_session_id>/
 *     └── (detail files produced by this teammate)
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

export const BASE_DIR = join(homedir(), ".pi", "pi-teammate");

/** Get the directory for a channel. */
export function getChannelDir(channel: string): string {
  return join(BASE_DIR, channel);
}

/** Get the path to the team DB file. */
export function getDbPath(channel: string): string {
  return join(getChannelDir(channel), "team.db");
}

/** Get the detail directory for a specific teammate. Creates it if needed. */
export function getTeammateDir(channel: string, teammateSessionId: string): string {
  const dir = join(getChannelDir(channel), teammateSessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Check if a channel exists (has a team.db file). */
export function channelExists(channel: string): boolean {
  return existsSync(getDbPath(channel));
}
