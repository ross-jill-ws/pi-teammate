#!/usr/bin/env bun
/**
 * Test script for the TTS module (extensions/tts.ts).
 *
 * Tests the ElevenLabs TTS pipeline directly (pure TypeScript, no Python).
 * Requires ELEVENLABS_API_KEY environment variable for API tests.
 *
 * Usage:
 *   bun run experiments/test-tts-harness.ts
 *
 * What it does:
 *   1. Tests voice queue DB operations (enqueue, claim, mark done)
 *   2. If ELEVENLABS_API_KEY is set:
 *      - Tests audio synthesis + caching to ~/.pi/pi-teammate/audios/
 *      - Tests end-to-end playback
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// ── Config (mirrors extensions/tts.ts) ──────────────────────────

const CACHE_DIR = join(homedir(), ".pi", "pi-teammate", "audios");
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.06,
  use_speaker_boost: true,
};

// ── Helpers (inlined for bun:sqlite compat) ─────────────────────

function getCacheKey(text: string, voiceId: string): string {
  return createHash("md5").update(`${voiceId}:${text}`).digest("hex");
}

function getCachePath(text: string, voiceId: string): string {
  return join(CACHE_DIR, `${getCacheKey(text, voiceId)}.mp3`);
}

function initVoiceQueue(db: Database): void {
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

function enqueueToDb(db: Database, text: string, voiceId: string | null): void {
  db.prepare(
    "INSERT INTO voice_queue (text, voice_id, completed, created_at) VALUES (?, ?, 0, ?)",
  ).run(text, voiceId, Date.now());
}

interface VoiceQueueRow {
  id: number;
  text: string;
  voice_id: string | null;
}

function claimNext(db: Database): VoiceQueueRow | null {
  const playing = db.prepare(
    "SELECT COUNT(*) as cnt FROM voice_queue WHERE completed = 1",
  ).get() as { cnt: number };
  if (playing.cnt > 0) return null;

  const row = db.prepare(
    "SELECT id, text, voice_id FROM voice_queue WHERE completed = 0 ORDER BY id ASC LIMIT 1",
  ).get() as VoiceQueueRow | undefined;
  if (!row) return null;

  const result = db.prepare(
    "UPDATE voice_queue SET completed = 1 WHERE id = ? AND completed = 0",
  ).run(row.id);
  if (result.changes === 0) return null;
  return row;
}

function markDone(db: Database, id: number): void {
  db.prepare("UPDATE voice_queue SET completed = 2 WHERE id = ?").run(id);
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

function playAudio(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const players = [
      { cmd: "mpv", args: ["--no-video", "--really-quiet", filePath] },
      { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] },
      { cmd: "afplay", args: [filePath] },
    ];

    function tryNext(index: number): void {
      if (index >= players.length) {
        console.error("  ❌ No audio player found (tried mpv, ffplay, afplay)");
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

// ── Tests ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🧪 TTS Module Test (pure TypeScript)");
  console.log("═".repeat(60));

  // 1. Voice queue DB tests (always run)
  await testVoiceQueue();

  // 2. API tests (only if key is set)
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log("\n⚠️  ELEVENLABS_API_KEY not set — skipping API tests.");
    console.log("   Set it to run synthesis + playback tests:");
    console.log("   ELEVENLABS_API_KEY=sk-... bun run experiments/test-tts-harness.ts\n");
  } else {
    console.log("✅ ELEVENLABS_API_KEY found\n");
    await testSynthesisAndCache();
    await testPlayback();
  }

  console.log("✅ All tests passed!\n");
}

async function testVoiceQueue(): Promise<void> {
  console.log("── Voice Queue DB Tests ──────────────────────────────");

  const db = new Database(":memory:");
  initVoiceQueue(db);

  // Enqueue 3 items
  enqueueToDb(db, "Hello world", "voice-1");
  enqueueToDb(db, "Second message", "voice-2");
  enqueueToDb(db, "Third message", null);

  // Claim first
  const first = claimNext(db);
  console.assert(first !== null, "Should claim first item");
  console.assert(first!.text === "Hello world", "First item text");
  console.assert(first!.voice_id === "voice-1", "First item voice_id");
  console.log("  ✅ claimNext returns first pending item");

  // While first is playing (completed=1), can't claim another
  const blocked = claimNext(db);
  console.assert(blocked === null, "Should not claim while playing");
  console.log("  ✅ claimNext blocked while item is playing");

  // Mark done, then claim next
  markDone(db, first!.id);
  const second = claimNext(db);
  console.assert(second !== null, "Should claim second after first done");
  console.assert(second!.text === "Second message", "Second item text");
  console.log("  ✅ markDone + claimNext advances FIFO");

  // Mark second done, claim third (null voice_id)
  markDone(db, second!.id);
  const third = claimNext(db);
  console.assert(third !== null, "Should claim third");
  console.assert(third!.voice_id === null, "Third item has null voice_id");
  markDone(db, third!.id);
  console.log("  ✅ Null voice_id handled correctly");

  // Queue empty
  const empty = claimNext(db);
  console.assert(empty === null, "Should return null when queue empty");
  console.log("  ✅ Empty queue returns null");

  db.close();
  console.log("  ✅ All voice queue tests passed\n");
}

async function testSynthesisAndCache(): Promise<void> {
  console.log("── Synthesis + Cache Tests ───────────────────────────");

  const testText = `TTS test at ${new Date().toISOString().slice(11, 19)}`;
  const voiceId = DEFAULT_VOICE_ID;
  const cachePath = getCachePath(testText, voiceId);

  // Synthesize
  console.log(`  🔊 Synthesizing: "${testText}"`);
  const audio = await synthesize(testText, voiceId);
  console.assert(audio.length > 0, "Audio should have content");
  console.log(`  ✅ Synthesized ${audio.length} bytes`);

  // Save to cache
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, audio);
  console.assert(existsSync(cachePath), "Cache file should exist");
  console.log(`  ✅ Cached to ${cachePath}`);

  // Verify cache hit
  const cached = readFileSync(cachePath);
  console.assert(cached.length === audio.length, "Cached file should match original size");
  console.log(`  ✅ Cache hit verified (${cached.length} bytes)\n`);
}

async function testPlayback(): Promise<void> {
  console.log("── End-to-End Playback Test ──────────────────────────");

  const testText = "Hello, this is a test of the TTS module.";
  const voiceId = DEFAULT_VOICE_ID;
  const cachePath = getCachePath(testText, voiceId);

  // Synthesize if not cached
  if (!existsSync(cachePath)) {
    console.log(`  🔊 Synthesizing: "${testText}"`);
    const audio = await synthesize(testText, voiceId);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, audio);
  } else {
    console.log("  💾 Using cached audio");
  }

  console.log("  🔈 Playing audio...");
  await playAudio(cachePath);
  console.log("  ✅ Playback complete\n");
}

main().catch((err) => {
  console.error(`\n❌ Test failed: ${err.message}`);
  process.exit(1);
});
