/**
 * Path helpers for pi-teammate.
 *
 * Directory layout:
 *   ~/.pi/pi-teammate/<channel>/<builder_session_id>/team.db
 *   ~/.pi/pi-teammate/<channel>/<builder_session_id>/<teammate_session_id>/
 *     └── (detail files produced by this teammate)
 *
 * The builder is the first agent who creates the channel. Other agents
 * discover the DB by scanning for the builder directory under the channel.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";

export const BASE_DIR = join(homedir(), ".pi", "pi-teammate");

/** Get the top-level directory for a channel. */
export function getChannelBaseDir(channel: string): string {
  return join(BASE_DIR, channel);
}

/** Get the directory for a channel+builder combination. */
export function getChannelDir(channel: string, builderSessionId: string): string {
  return join(BASE_DIR, channel, builderSessionId);
}

/** Get the path to the team DB file. */
export function getDbPath(channel: string, builderSessionId: string): string {
  return join(getChannelDir(channel, builderSessionId), "team.db");
}

/** Get the detail directory for a specific teammate. Creates it if needed. */
export function getTeammateDir(channel: string, builderSessionId: string, teammateSessionId: string): string {
  const dir = join(getChannelDir(channel, builderSessionId), teammateSessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Find an existing channel's builder session ID by scanning the channel directory.
 * Returns the builder session ID if found, null if the channel doesn't exist.
 */
export function findBuilderSessionId(channel: string): string | null {
  const channelBase = getChannelBaseDir(channel);
  if (!existsSync(channelBase)) return null;

  // Look for a subdirectory that contains team.db
  try {
    const entries = readdirSync(channelBase);
    for (const entry of entries) {
      const candidate = join(channelBase, entry, "team.db");
      if (existsSync(candidate)) {
        return entry;
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

/**
 * Resolve the DB path for a channel.
 * - If the channel already exists, find the builder and return its DB path.
 * - If creating new, use the provided builderSessionId.
 * Returns { dbPath, builderSessionId, exists }.
 */
export function resolveChannel(channel: string, builderSessionId?: string): {
  dbPath: string;
  builderSessionId: string;
  channelDir: string;
  exists: boolean;
} {
  const existing = findBuilderSessionId(channel);
  if (existing) {
    return {
      dbPath: getDbPath(channel, existing),
      builderSessionId: existing,
      channelDir: getChannelDir(channel, existing),
      exists: true,
    };
  }

  // Channel doesn't exist yet — need a builder session ID
  if (!builderSessionId) {
    throw new Error(`Channel "${channel}" does not exist. Create it first with /team-create.`);
  }

  return {
    dbPath: getDbPath(channel, builderSessionId),
    builderSessionId,
    channelDir: getChannelDir(channel, builderSessionId),
    exists: false,
  };
}
