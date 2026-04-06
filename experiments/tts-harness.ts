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
 * Requires ELEVENLABS_API_KEY environment variable.
 *
 * Usage (load alongside pi-teammate):
 *   pi -e /path/to/pi-teammate/experiments/tts-harness.ts --team-channel lab --agent-name designer
 *
 * Commands:
 *   /tts-test <text>  — speak the given text using this agent's voiceId
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import Database from "better-sqlite3";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import YAML from "yaml";

// ── Config ──────────────────────────────────────────────────────

const SPOKEN_EVENTS = new Set(["task_req", "task_ack", "task_update", "task_done", "task_fail", "broadcast"]);
const POLL_INTERVAL_MS = 300;

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const CACHE_DIR = join(homedir(), ".pi", "pi-teammate", "audios");

const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.06,
  use_speaker_boost: true,
};

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
  const playing = db.prepare(
    "SELECT COUNT(*) as cnt FROM voice_queue WHERE completed = 1"
  ).get() as { cnt: number };
  if (playing.cnt > 0) return null;

  const row = db.prepare(
    "SELECT id, text, voice_id FROM voice_queue WHERE completed = 0 ORDER BY id ASC LIMIT 1"
  ).get() as VoiceQueueRow | undefined;
  if (!row) return null;

  const result = db.prepare(
    "UPDATE voice_queue SET completed = 1 WHERE id = ? AND completed = 0"
  ).run(row.id);

  if (result.changes === 0) return null;
  return row;
}

function markDone(db: Database.Database, id: number): void {
  db.prepare("UPDATE voice_queue SET completed = 2 WHERE id = ?").run(id);
}

// ── ElevenLabs TTS with MP3 caching ─────────────────────────────

function getCacheKey(text: string, voiceId: string): string {
  return createHash("md5").update(`${voiceId}:${text}`).digest("hex");
}

function getCachePath(text: string, voiceId: string): string {
  return join(CACHE_DIR, `${getCacheKey(text, voiceId)}.mp3`);
}

async function synthesize(text: string, voiceId: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not set");
  }

  const url = `${ELEVENLABS_TTS_URL}/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs API ${response.status}: ${body}`);
  }

  const arrayBuf = await response.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Get MP3 audio for the given text, using cache if available.
 * Returns the path to the MP3 file.
 */
async function getAudioFile(text: string, voiceId: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });

  const cachePath = getCachePath(text, voiceId);
  if (existsSync(cachePath)) {
    return cachePath;
  }

  const audio = await synthesize(text, voiceId);
  writeFileSync(cachePath, audio);
  return cachePath;
}

/**
 * Play an MP3 file using the best available player (mpv > ffplay > afplay).
 */
function playAudio(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    // Try players in order of preference
    const players = [
      { cmd: "mpv", args: ["--no-video", "--really-quiet", filePath] },
      { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] },
      { cmd: "afplay", args: [filePath] }, // macOS only
    ];

    function tryNext(index: number): void {
      if (index >= players.length) {
        console.error("[tts] ❌ No audio player found (tried mpv, ffplay, afplay)");
        resolve();
        return;
      }

      const { cmd, args } = players[index];
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });

      child.on("error", () => {
        // Player not found, try next
        tryNext(index + 1);
      });

      child.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          tryNext(index + 1);
        }
      });
    }

    tryNext(0);
  });
}

/**
 * Full TTS pipeline: synthesize (or use cache) → play.
 */
async function speak(text: string, voiceId: string | null): Promise<void> {
  const vid = voiceId || DEFAULT_VOICE_ID;
  try {
    const filePath = await getAudioFile(text, vid);
    await playAudio(filePath);
  } catch (err: any) {
    console.error(`[tts] ❌ TTS error: ${err.message}`);
  }
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

      if (!process.env.ELEVENLABS_API_KEY) {
        ctx.ui.notify("ELEVENLABS_API_KEY not set", "error");
        return;
      }

      if (selfVoiceId === null) {
        selfVoiceId = loadVoiceId(ctx.cwd);
      }

      ctx.ui.notify(`Speaking: "${text}" (voice: ${selfVoiceId ?? DEFAULT_VOICE_ID})`, "info");
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

    if (!process.env.ELEVENLABS_API_KEY) {
      console.error("[tts] ⚠️  ELEVENLABS_API_KEY not set — TTS will not work");
    }

    if (!channel) {
      console.log("[tts] No --team-channel flag, TTS queue inactive (but /tts-test still works).");
      return;
    }

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

// ── Exported for testing ────────────────────────────────────────

export {
  synthesize,
  getAudioFile,
  playAudio,
  speak,
  getCachePath,
  CACHE_DIR,
  DEFAULT_VOICE_ID,
  initVoiceQueue,
  enqueueToDb,
  claimNext,
  markDone,
};
export type { VoiceQueueRow };
