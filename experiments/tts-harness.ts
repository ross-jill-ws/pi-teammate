/**
 * TTS Harness — pi extension that speaks teammate messages aloud via ElevenLabs TTS.
 *
 * Listens for teammate_message events emitted by MAMORU and speaks
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import YAML from "yaml";

// ── Config ──────────────────────────────────────────────────────

const TTS_SCRIPT = join(homedir(), ".claude", "tts_11labs_cache.py");
const SPOKEN_EVENTS = new Set(["task_req", "task_ack", "task_update", "task_done", "task_fail", "broadcast"]);

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

// ── TTS ─────────────────────────────────────────────────────────

const speechQueue: Array<{ text: string; voiceId: string | null }> = [];
let speaking = false;

function enqueue(text: string, voiceId: string | null): void {
  speechQueue.push({ text, voiceId });
  if (!speaking) drainQueue();
}

async function drainQueue(): Promise<void> {
  speaking = true;
  while (speechQueue.length > 0) {
    const item = speechQueue.shift()!;
    await speak(item.text, item.voiceId);
  }
  speaking = false;
}

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
    console.log(`[tts] 🎙️ TTS harness active. Own voiceId: ${selfVoiceId ?? "(default)"}`);

    if (!existsSync(TTS_SCRIPT)) {
      console.error(`[tts] ❌ TTS script not found: ${TTS_SCRIPT}`);
    }
  });

  // ── Listen for teammate messages ──────────────────────────────
  pi.events.on("teammate_message", (data: any) => {
    const { event, content, otherParty, direction } = data;

    if (!content || typeof content !== "string") return;
    if (!SPOKEN_EVENTS.has(event)) return;

    // Only speak sent messages — each agent voices its own output,
    // so every message is spoken exactly once across the team.
    if (direction !== "sent") return;
    enqueue(content, selfVoiceId);
  });
}
