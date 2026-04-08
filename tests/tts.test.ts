import { describe, test, expect } from "bun:test";
import { setupTts } from "../extensions/tts.ts";
import { createMockPi, createMockCtx, createTestDb } from "./helpers/mock-pi.ts";

describe("TTS", () => {
  test("/tts-test falls back to direct speak when no team DB is available", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx({ cwd: "/tmp/pi-teammate-tts-test" });
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

    const cmd = pi.registeredCommands.get("tts-test");
    expect(cmd).toBeDefined();

    await cmd.handler("Hello, this is a voice test", ctx as any);

    expect(spoken).toEqual([
      { text: "Hello, this is a voice test", voiceId: null },
    ]);
    expect(ctx.notifications.some((n) => n.message.includes("Speaking:"))).toBe(true);
  });

  test("onSessionStart starts the poll timer even without a channel and does not double-init", () => {
    const pi = createMockPi();
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
    tts.onSessionStart(ctx as any, "dev");

    expect(intervalCalls).toBe(1);
    expect(ctx.statuses.get("tts")).toBe("audio: on");
  });

  test("recovers stale voice_queue claims and continues draining", async () => {
    const pi = createMockPi();
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
