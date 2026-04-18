import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTts } from "../extensions/tts.ts";
import { createMockPi, createMockCtx, createTestDb } from "./helpers/mock-pi.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-teammate-tts-"));
}

describe("TTS", () => {
  test("/team-audio controls /tts-test when no team DB is available", async () => {
    const dir = makeTmpDir();
    try {
      const pi = createMockPi();
      pi.flags.set("team-audio", "off");
      const ctx = createMockCtx({ cwd: dir });
      const spoken: Array<{ text: string; voiceId: string | null }> = [];

      const tts = setupTts(
        pi as any,
        () => null,
        {
          speakImpl: async (text, voiceId) => {
            spoken.push({ text, voiceId });
          },
          setIntervalImpl: (() => ({}) as any) as any,
          clearIntervalImpl: (() => {}) as any,
        },
      );

      tts.onSessionStart(ctx as any, null);

      const ttsTest = pi.registeredCommands.get("tts-test");
      const teamAudio = pi.registeredCommands.get("team-audio");
      expect(ttsTest).toBeDefined();
      expect(teamAudio).toBeDefined();
      expect(ctx.statuses.get("tts")).toBe("audio: off");

      await ttsTest.handler("Hello while off", ctx as any);
      expect(spoken).toEqual([]);
      expect(ctx.notifications.some((n) => n.message.includes("Audio is off"))).toBe(true);

      teamAudio.handler("on", ctx as any);
      expect(ctx.statuses.get("tts")).toBe("audio: on");

      await ttsTest.handler("Hello, this is a voice test", ctx as any);
      expect(spoken).toEqual([
        { text: "Hello, this is a voice test", voiceId: null },
      ]);

      teamAudio.handler("", ctx as any); // toggle back off
      expect(ctx.statuses.get("tts")).toBe("audio: off");

      await ttsTest.handler("Should stay silent", ctx as any);
      expect(spoken).toEqual([
        { text: "Hello, this is a voice test", voiceId: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("voiceId: none hard-disables audio and prevents poller startup", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "persona.yaml"), [
        'name: "Muted"',
        'description: "Silent teammate"',
        'voiceId: "none"',
      ].join("\n"), "utf-8");

      const pi = createMockPi();
      pi.flags.set("team-audio", "on");
      const ctx = createMockCtx({ cwd: dir });
      const spoken: Array<{ text: string; voiceId: string | null }> = [];
      let intervalCalls = 0;

      const tts = setupTts(
        pi as any,
        () => null,
        {
          speakImpl: async (text, voiceId) => {
            spoken.push({ text, voiceId });
          },
          setIntervalImpl: (() => {
            intervalCalls += 1;
            return { id: intervalCalls } as any;
          }) as any,
          clearIntervalImpl: (() => {}) as any,
        },
      );

      tts.onSessionStart(ctx as any, null);

      const ttsTest = pi.registeredCommands.get("tts-test");
      const teamAudio = pi.registeredCommands.get("team-audio");
      expect(ctx.statuses.get("tts")).toBe("audio: off");
      expect(intervalCalls).toBe(0);

      await ttsTest.handler("Please do not speak", ctx as any);
      expect(spoken).toEqual([]);
      expect(ctx.notifications.some((n) => n.message.includes("voiceId: \"none\""))).toBe(true);

      teamAudio.handler("on", ctx as any);
      expect(ctx.statuses.get("tts")).toBe("audio: off");
      expect(intervalCalls).toBe(0);
      expect(ctx.notifications.some((n) => n.message.includes("persona.yaml keeps audio off"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--team-audio off overrides ELEVENLABS_API_KEY until changed by command", () => {
    const prevKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key";

    try {
      const pi = createMockPi();
      pi.flags.set("team-audio", "off");
      const ctx = createMockCtx();
      let intervalCalls = 0;

      const tts = setupTts(
        pi as any,
        () => null,
        {
          speakImpl: async () => {},
          setIntervalImpl: (() => {
            intervalCalls += 1;
            return { id: intervalCalls } as any;
          }) as any,
          clearIntervalImpl: (() => {}) as any,
        },
      );

      tts.onSessionStart(ctx as any, null);
      expect(ctx.statuses.get("tts")).toBe("audio: off");
      expect(intervalCalls).toBe(0);

      const teamAudio = pi.registeredCommands.get("team-audio");
      teamAudio.handler("on", ctx as any);

      expect(ctx.statuses.get("tts")).toBe("audio: on");
      expect(intervalCalls).toBe(1);
    } finally {
      if (prevKey === undefined) {
        delete process.env.ELEVENLABS_API_KEY;
      } else {
        process.env.ELEVENLABS_API_KEY = prevKey;
      }
    }
  });

  test("recovers stale voice_queue claims and continues draining", async () => {
    const pi = createMockPi();
    pi.flags.set("team-audio", "on");
    const ctx = createMockCtx();
    const db = createTestDb();
    const spoken: string[] = [];
    let pollFn: (() => any) | null = null;

    const tts = setupTts(
      pi as any,
      () => db,
      {
        speakImpl: async (text) => {
          spoken.push(text);
        },
        setIntervalImpl: ((fn: () => any) => {
          pollFn = fn;
          return { id: 1 } as any;
        }) as any,
        clearIntervalImpl: (() => {}) as any,
      },
    );

    tts.onSessionStart(ctx as any, "dev");
    expect(pollFn).not.toBeNull();

    await pollFn!(); // initialize/migrate voice_queue

    const staleTs = Date.now() - 10 * 60 * 1000;
    db.prepare(
      "INSERT INTO voice_queue (id, text, voice_id, completed, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(1, "stale playing", null, 1, staleTs, null);
    db.prepare(
      "INSERT INTO voice_queue (id, text, voice_id, completed, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(2, "next pending", null, 0, Date.now(), null);

    await pollFn!();

    expect(spoken).toEqual(["stale playing", "next pending"]);
    const counts = db.prepare("SELECT completed, count(*) as cnt FROM voice_queue GROUP BY completed ORDER BY completed ASC").all() as Array<{ completed: number; cnt: number }>;
    expect(counts).toEqual([{ completed: 2, cnt: 2 }]);
  });
});
