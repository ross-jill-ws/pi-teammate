/**
 * TTS module — ElevenLabs text-to-speech with MP3 caching and shared voice queue.
 *
 * Uses a shared `voice_queue` table in the team SQLite DB so that all agents
 * on the same machine enqueue speech into a single FIFO. One poller drains
 * the queue, ensuring messages are spoken in order with no overlap or duplicates.
 *
 * Activated only when ELEVENLABS_API_KEY is set.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { loadPersona } from "./persona.ts";

// ── Config ──────────────────────────────────────────────────────

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const CACHE_DIR = join(homedir(), ".pi", "pi-teammate", "audios");
const POLL_INTERVAL_MS = 300;
const STALE_CLAIM_MS = 120_000;

const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.06,
  use_speaker_boost: true,
};

const SPOKEN_EVENTS = new Set([
  "task_req", "task_ack", "task_update", "task_done", "task_fail", "broadcast",
]);

// ── Voice queue schema & helpers ────────────────────────────────

interface VoiceQueueRow {
  id: number;
  text: string;
  voice_id: string | null;
}

interface VoiceQueueColumnInfo {
  name: string;
}

function initVoiceQueue(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      voice_id TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    )
  `);

  const columns = db.prepare("PRAGMA table_info(voice_queue)").all() as VoiceQueueColumnInfo[];
  const hasClaimedAt = columns.some((column) => column.name === "claimed_at");
  if (!hasClaimedAt) {
    db.exec("ALTER TABLE voice_queue ADD COLUMN claimed_at INTEGER");
  }
}

function enqueueToDb(db: Database.Database, text: string, voiceId: string | null): void {
  db.prepare(
    "INSERT INTO voice_queue (text, voice_id, completed, created_at) VALUES (?, ?, 0, ?)",
  ).run(text, voiceId, Date.now());
}

/**
 * Atomically claim the next pending row, but ONLY if nothing is currently playing.
 * completed: 0=pending, 1=playing, 2=done.
 */
function recoverStaleClaims(db: Database.Database, now: number = Date.now()): number {
  const cutoff = now - STALE_CLAIM_MS;
  const result = db.prepare(`
    UPDATE voice_queue
    SET completed = 0, claimed_at = NULL
    WHERE completed = 1
      AND (
        (claimed_at IS NOT NULL AND claimed_at < ?)
        OR
        (claimed_at IS NULL AND created_at < ?)
      )
  `).run(cutoff, cutoff);

  if (result.changes > 0) {
    console.warn(`[tts] Recovered ${result.changes} stale voice queue claim${result.changes === 1 ? "" : "s"}.`);
  }
  return result.changes;
}

function claimNext(db: Database.Database, now: number = Date.now()): VoiceQueueRow | null {
  recoverStaleClaims(db, now);

  const playing = db.prepare(
    "SELECT COUNT(*) as cnt FROM voice_queue WHERE completed = 1",
  ).get() as { cnt: number };
  if (playing.cnt > 0) return null;

  const row = db.prepare(
    "SELECT id, text, voice_id FROM voice_queue WHERE completed = 0 ORDER BY id ASC LIMIT 1",
  ).get() as VoiceQueueRow | undefined;
  if (!row) return null;

  const result = db.prepare(
    "UPDATE voice_queue SET completed = 1, claimed_at = ? WHERE id = ? AND completed = 0",
  ).run(now, row.id);
  if (result.changes === 0) return null;
  return row;
}

function markDone(db: Database.Database, id: number): void {
  db.prepare("UPDATE voice_queue SET completed = 2, claimed_at = NULL WHERE id = ?").run(id);
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
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

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

  return Buffer.from(await response.arrayBuffer());
}

async function getAudioFile(text: string, voiceId: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = getCachePath(text, voiceId);
  if (existsSync(cachePath)) return cachePath;

  const audio = await synthesize(text, voiceId);
  writeFileSync(cachePath, audio);
  return cachePath;
}

function playAudio(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const players = [
      { cmd: "mpv", args: ["--no-video", "--really-quiet", filePath] },
      { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] },
      { cmd: "afplay", args: [filePath] },
    ];

    function tryNext(index: number): void {
      if (index >= players.length) {
        resolve();
        return;
      }
      const { cmd, args } = players[index];
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => tryNext(index + 1));
      child.on("close", (code) => {
        if (code === 0 || code === null) resolve();
        else tryNext(index + 1);
      });
    }

    tryNext(0);
  });
}

async function speak(text: string, voiceId: string | null): Promise<void> {
  try {
    const filePath = await getAudioFile(text, voiceId || DEFAULT_VOICE_ID);
    await playAudio(filePath);
  } catch (err: any) {
    console.error(`[tts] ❌ ${err.message}`);
  }
}

// ── Public: wire TTS into the extension ─────────────────────────

export function isEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

/**
 * Set up TTS: register /tts-test command, listen for teammate_message events,
 * and start the voice queue poller when a team channel is active.
 *
 * Call this once from the main extension entry point.
 * No-op if ELEVENLABS_API_KEY is not set.
 */
export function setupTts(
  pi: ExtensionAPI,
  getDb: () => Database.Database | null,
  deps?: {
    speakImpl?: (text: string, voiceId: string | null) => Promise<void>;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
  },
): { onSessionStart: (ctx: ExtensionContext, channel: string | null) => void; onShutdown: () => void } {
  const speakImpl = deps?.speakImpl ?? speak;
  const setIntervalImpl = deps?.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps?.clearIntervalImpl ?? clearInterval;

  let selfVoiceId: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let draining = false;
  let voiceQueueReady = false;
  let activeChannel: string | null = null;

  function ensureVoiceQueue(): Database.Database | null {
    const db = getDb();
    if (!db) return null;
    if (!voiceQueueReady) {
      try {
        initVoiceQueue(db);
        voiceQueueReady = true;
      } catch {
        return null;
      }
    }
    return db;
  }

  function enqueue(text: string, voiceId: string | null): boolean {
    const db = ensureVoiceQueue();
    if (!db) return false;
    try {
      enqueueToDb(db, text, voiceId);
      void drain();
      return true;
    } catch {
      // DB might be busy; skip silently
      return false;
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    const db = ensureVoiceQueue();
    if (!db) return;

    draining = true;
    try {
      while (true) {
        let claimed: VoiceQueueRow | null = null;
        try {
          claimed = claimNext(db);
        } catch {
          break;
        }
        if (!claimed) break;
        await speakImpl(claimed.text, claimed.voice_id);
        try {
          markDone(db, claimed.id);
        } catch {
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  // ── /tts-test command ───────────────────────────────────────
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
      ctx.ui.notify(`Speaking: "${text}" (voice: ${selfVoiceId ?? DEFAULT_VOICE_ID})`, "info");
      if (!enqueue(text, selfVoiceId)) {
        await speakImpl(text, selfVoiceId);
      }
    },
  });

  // ── Listen for teammate messages ────────────────────────────
  pi.events.on("teammate_message", (data: any) => {
    const { event, content, direction } = data;
    if (!content || typeof content !== "string") return;
    if (!SPOKEN_EVENTS.has(event)) return;
    if (direction !== "sent") return;
    enqueue(content, selfVoiceId);
  });

  return {
    onSessionStart(ctx: ExtensionContext, channel: string | null) {
      selfVoiceId = loadVoiceId(ctx.cwd);
      activeChannel = channel;

      ctx.ui.setStatus("tts", "audio: on");

      // Start the poll timer once per session. This lets /tts-test work
      // even before a team DB exists, and also covers the later /team-join
      // path because getDb() will begin returning the active DB once joined.
      if (!pollTimer) {
        pollTimer = setIntervalImpl(() => drain(), POLL_INTERVAL_MS) as ReturnType<typeof setInterval>;
      }
    },

    onShutdown() {
      if (pollTimer) {
        clearIntervalImpl(pollTimer);
        pollTimer = null;
      }
    },
  };
}

// ── Helper ──────────────────────────────────────────────────────

function loadVoiceId(dir: string): string | null {
  try {
    const persona = loadPersona(dir);
    return (persona as any)?.voiceId ?? null;
  } catch {
    return null;
  }
}
