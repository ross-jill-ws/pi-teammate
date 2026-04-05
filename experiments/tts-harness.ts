/**
 * TTS Harness — pi extension that speaks teammate messages aloud via ElevenLabs TTS.
 *
 * Uses a shared `voice_queue` table in the team SQLite DB so that all agents
 * on the same machine enqueue speech into a single FIFO. One poller drains
 * the queue, ensuring messages are spoken in order with no overlap or duplicates.
 *
 * Listens for teammate_message events emitted by MAMORU and enqueues
 * the content for: task_req, task_ack, task_update, task_done, task_fail, broadcast
 *
 * Each agent's voice is determined by the `voiceId` field in their persona.yaml.
 *
 * Usage (load alongside pi-teammate):
 *   pi -e /path/to/pi-teammate/experiments/tts-harness.ts --team-channel lab --agent-name designer
 *
 * Commands:
 *   /tts-test <text>  — speak the given text using this agent's voiceId
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import YAML from "yaml";

// ── Config ──────────────────────────────────────────────────────

const TTS_SCRIPT = join(homedir(), ".claude", "tts_11labs_cache.py");
const SPOKEN_EVENTS = new Set(["task_req", "task_ack", "task_update", "task_done", "task_fail", "broadcast"]);
const POLL_INTERVAL_MS = 300;

// ── Voice resolution ────────────────────────────────────────────

function loadVoiceId(dir: string): string | null {
  const personaPath = join(dir, "persona.yaml");
  if (!existsSync(personaPath)) return null;
  try {
    const raw = readFileSync(personaPath, "utf-8");
    const doc = YAML.parse(raw);
    return doc?.voiceId ?? null;
  } catch {
    return null;
  }
}

// ── DB path ─────────────────────────────────────────────────────

function getDbPath(channel: string): string {
  return join(homedir(), ".pi", "pi-teammate", channel, "team.db");
}

// ── Voice queue schema & helpers ───────────────────────────────────

function initVoiceQueue(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      voice_id TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
}

function enqueueToDb(db: Database.Database, text: string, voiceId: string | null): void {
  db.prepare(
    "INSERT INTO voice_queue (text, voice_id, completed, created_at) VALUES (?, ?, 0, ?)"
  ).run(text, voiceId, Date.now());
}

interface VoiceQueueRow {
  id: number;
  text: string;
  voice_id: string | null;
}

/**
 * Atomically claim the next pending row, but ONLY if nothing is currently playing.
 * Uses completed: 0=pending, 1=playing, 2=done.
 * At any time, at most one row across all agents can be in state 1 (playing).
 */
function claimNext(db: Database.Database): VoiceQueueRow | null {
  // If any row is currently playing, don't claim another
  const playing = db.prepare(
    "SELECT COUNT(*) as cnt FROM voice_queue WHERE completed = 1"
  ).get() as { cnt: number };
  if (playing.cnt > 0) return null;

  // Peek at the next pending row
  const row = db.prepare(
    "SELECT id, text, voice_id FROM voice_queue WHERE completed = 0 ORDER BY id ASC LIMIT 1"
  ).get() as VoiceQueueRow | undefined;
  if (!row) return null;

  // Atomically claim it — only succeeds if still pending (completed = 0)
  const result = db.prepare(
    "UPDATE voice_queue SET completed = 1 WHERE id = ? AND completed = 0"
  ).run(row.id);

  // If changes === 0, another agent already claimed it
  if (result.changes === 0) return null;
  return row;
}

function markDone(db: Database.Database, id: number): void {
  db.prepare("UPDATE voice_queue SET completed = 2 WHERE id = ?").run(id);
}

// ── TTS playback ────────────────────────────────────────────────

function speak(text: string, voiceId: string | null): Promise<void> {
  return new Promise((resolve) => {
    const args = [TTS_SCRIPT, text];
    if (voiceId) {
      args.push("--voice-id", voiceId);
    }

    const child = spawn("uv", ["run", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[tts] ❌ ${data.toString().trim()}\n`);
    });

    child.on("close", () => resolve());
    child.on("error", (err) => {
      console.error(`[tts] ❌ Failed to spawn TTS: ${err.message}`);
      resolve();
    });
  });
}

// ── Extension entry point ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let selfVoiceId: string | null = null;
  let db: Database.Database | null = null;
  let channel: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let draining = false;

  let voiceQueueReady = false;

  /** Open (or reopen) the team DB and ensure voice_queue table exists. */
  function ensureDb(): Database.Database | null {
    if (db && voiceQueueReady) return db;
    if (!channel) return null;
    const dbPath = getDbPath(channel);
    if (!existsSync(dbPath)) return null;
    try {
      if (!db) db = new Database(dbPath);
      if (!voiceQueueReady) {
        initVoiceQueue(db);
        voiceQueueReady = true;
      }
      return db;
    } catch {
      return null;
    }
  }

  /** Enqueue text to the shared voice_queue table. */
  function enqueue(text: string, voiceId: string | null): void {
    const d = ensureDb();
    if (!d) return;
    try {
      enqueueToDb(d, text, voiceId);
    } catch {
      // DB might be busy; skip silently
    }
  }

  /** Poll the voice_queue and play the next uncompleted entry (FIFO). */
  async function drain(): Promise<void> {
    if (draining) return;
    const d = ensureDb();
    if (!d) return;

    draining = true;
    try {
      while (true) {
        let claimed: VoiceQueueRow | null = null;
        try {
          claimed = claimNext(d);
        } catch {
          break;
        }
        if (!claimed) break;

        await speak(claimed.text, claimed.voice_id);

        try {
          markDone(d, claimed.id);
        } catch {
          // DB busy; will retry next cycle
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  // ── /tts-test command ─────────────────────────────────────────
  pi.registerCommand("tts-test", {
    description: "Speak text using this agent's voiceId. Usage: /tts-test <text>",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /tts-test <text>", "error");
        return;
      }

      if (selfVoiceId === null) {
        selfVoiceId = loadVoiceId(ctx.cwd);
      }

      ctx.ui.notify(`Speaking: "${text}" (voice: ${selfVoiceId ?? "default"})`, "info");
      enqueue(text, selfVoiceId);
    },
  });

  // ── Load own voice on startup ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    selfVoiceId = loadVoiceId(ctx.cwd);

    // Read --team-channel from CLI args directly (flag is registered by pi-teammate,
    // but pi.getFlag only returns flags registered by this extension).
    const args = process.argv;
    const channelIdx = args.indexOf("--team-channel");
    channel = channelIdx >= 0 && args[channelIdx + 1] ? args[channelIdx + 1] : null;

    if (!existsSync(TTS_SCRIPT)) {
      console.error(`[tts] ❌ TTS script not found: ${TTS_SCRIPT}`);
    }

    if (!channel) {
      console.log("[tts] No --team-channel flag, TTS queue inactive (but /tts-test still works).");
      return;
    }

    // Don't create voice_queue here — with --team-new, pi-teammate deletes
    // and recreates the DB during session_start. The table is created lazily
    // on first enqueue/drain, by which point the DB is stable.
    pollTimer = setInterval(() => drain(), POLL_INTERVAL_MS);
    console.log(`[tts] 🎙️ TTS harness polling channel "${channel}"`);
  });

  // ── Listen for teammate messages ──────────────────────────────
  pi.events.on("teammate_message", (data: any) => {
    const { event, content, direction } = data;

    if (!content || typeof content !== "string") return;
    if (!SPOKEN_EVENTS.has(event)) return;

    // Only enqueue sent messages — each agent voices its own output,
    // so every message is enqueued exactly once across the team.
    if (direction !== "sent") return;
    enqueue(content, selfVoiceId);
  });

  // ── Cleanup ───────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  });
}
