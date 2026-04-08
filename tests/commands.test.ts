import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerCommands, setupHintWatcher, formatUsageHint } from "../extensions/commands.ts";
import { createMockPi, createMockCtx, type MockPi, type MockCtx } from "./helpers/mock-pi.ts";

// setImmediate is used by setupHintWatcher to defer checks until after the
// editor has applied input. Wait one macrotask before assertions.
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Helpers ──────────────────────────────────────────────────────

function setup() {
  const pi = createMockPi();
  let mamoru: any = null;
  let extCtx: MockCtx | null = null;
  const bootstrapCalls: Array<{ channel: string; agentName: string }> = [];

  const { hintRegistry } = registerCommands(
    pi as any,
    () => mamoru,
    (m) => { mamoru = m; },
    () => extCtx as any,
    {
      bootstrapMamoru: (_ctx, channel, agentName) => {
        bootstrapCalls.push({ channel, agentName });
        // Simulate a minimal "active" mamoru object
        mamoru = {
          getChannel: () => channel,
          getAgentName: () => agentName,
          getSessionId: () => "fake-session",
          stop: () => {},
        };
      },
    },
  );

  return {
    pi,
    hintRegistry,
    bootstrapCalls,
    setExtCtx: (c: MockCtx) => { extCtx = c; },
    getMamoru: () => mamoru,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-teammate-cmds-test-"));
}

// ── /team-join — agent name fallback ─────────────────────────────

describe("/team-join agent name resolution", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("uses explicit agent name when provided", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);

    // Create a persona.yaml that should be ignored when explicit name is given
    writeFileSync(join(tmpDir, "persona.yaml"),
      "name: PersonaName\ndescription: x\n", "utf-8");

    const cmd = pi.registeredCommands.get("team-join");
    expect(cmd).toBeDefined();
    await cmd.handler("dev Alice", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0]).toEqual({ channel: "dev", agentName: "Alice" });
  });

  test("falls back to persona.yaml name when no explicit name", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);

    writeFileSync(join(tmpDir, "persona.yaml"),
      "name: Rachel\ndescription: voice agent\n", "utf-8");

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0]).toEqual({ channel: "dev", agentName: "Rachel" });
  });

  test("falls back to session id when neither explicit name nor persona.yaml", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-xyz", cwd: tmpDir });
    setExtCtx(ctx);

    // No persona.yaml in tmpDir
    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0]).toEqual({ channel: "dev", agentName: "sess-xyz" });
  });

  test("session id fallback used when persona.yaml has no name", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-fallback", cwd: tmpDir });
    setExtCtx(ctx);

    // persona.yaml exists but is invalid (missing required fields) → loadPersona throws
    writeFileSync(join(tmpDir, "persona.yaml"), "description: only description\n", "utf-8");

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev", ctx);

    // Should not crash; should fall back to session id
    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].agentName).toBe("sess-fallback");
  });
});


// -- Argument completion dropdowns (pure filtering) --

describe("argument completion dropdowns", () => {
  test("registers getArgumentCompletions on team-* / task-* commands", () => {
    const { pi } = setup();
    for (const name of ["team-create", "team-join", "team-leave", "team-remove-inactive", "team-send", "team-history", "task-cancel", "task-history"]) {
      const cmd = pi.registeredCommands.get(name);
      expect(cmd).toBeDefined();
      expect(typeof cmd.getArgumentCompletions).toBe("function");
    }
  });

  test("returns autocomplete examples for team-join", () => {
    const { pi } = setup();
    const cmd = pi.registeredCommands.get("team-join");
    const items = cmd.getArgumentCompletions("");
    expect(Array.isArray(items)).toBe(true);
    expect(items!.length).toBeGreaterThan(0);
    expect(items![0]).toHaveProperty("value");
    expect(items![0]).toHaveProperty("label");
    expect(items![0]).toHaveProperty("description");
  });

  test("getArgumentCompletions has NO notification side-effect (now handled by setupHintWatcher)", () => {
    const { pi, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: "/tmp" });
    setExtCtx(ctx);

    const cmd = pi.registeredCommands.get("team-join");
    cmd.getArgumentCompletions("");
    cmd.getArgumentCompletions("");
    cmd.getArgumentCompletions("d");

    // Notify should NOT have been called by getArgumentCompletions itself.
    expect(ctx.notifications.filter((n) => n.message.includes("Usage:"))).toHaveLength(0);
  });

  test("filters autocomplete examples by typed prefix", () => {
    const { pi } = setup();
    const cmd = pi.registeredCommands.get("team-join");
    const items = cmd.getArgumentCompletions("dev ");
    expect(Array.isArray(items) || items === null).toBe(true);
    if (items) {
      for (const item of items) {
        expect(item.value.toLowerCase().startsWith("dev ")).toBe(true);
      }
    }
  });
});

// -- Slash-command usage hint registry --

describe("hint registry", () => {
  test("registerCommands populates hintRegistry for all team-/task- commands", () => {
    const { hintRegistry } = setup();
    for (const name of ["team-create", "team-join", "team-leave", "team-remove-inactive", "team-send", "team-history", "task-cancel", "task-history"]) {
      expect(hintRegistry.has(name)).toBe(true);
      const hint = hintRegistry.get(name)!;
      expect(hint.summary).toBeTruthy();
      expect(Array.isArray(hint.examples)).toBe(true);
    }
  });

  test("formatUsageHint produces multi-line text with summary + examples", () => {
    const text = formatUsageHint({
      summary: "Usage: /foo <bar>",
      examples: [
        { value: "baz", label: "baz", description: "do baz" },
        { value: "qux", label: "qux", description: "do qux" },
      ],
    });
    expect(text).toContain("Usage: /foo <bar>");
    expect(text).toContain("Examples:");
    expect(text).toContain("baz");
    expect(text).toContain("do baz");
    expect(text).toContain("qux");
  });

  test("formatUsageHint omits Examples section when no examples", () => {
    const text = formatUsageHint({ summary: "Usage: /foo", examples: [] });
    expect(text).toBe("Usage: /foo");
  });
});

// -- setupHintWatcher (terminal-input notification) --

describe("setupHintWatcher", () => {
  test("fires ctx.ui.notify when editor text becomes '/team-join '", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    // Simulate the user typing '/team-join' then a space.
    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();

    const hint = ctx.notifications.find((n) => n.message.includes("Usage: /team-join"));
    expect(hint).toBeDefined();
    expect(hint!.type).toBe("info");
    expect(hint!.message).toContain("dev Alice");
  });

  test("fires once even with multiple keystrokes inside the same '/cmd ' state", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();
    // Another input event without changing the editor text (e.g. arrow key).
    ctx.simulateInput("\x1b[D", "/team-join ");
    await flushImmediate();

    const hints = ctx.notifications.filter((n) => n.message.includes("Usage: /team-join"));
    expect(hints).toHaveLength(1);
  });

  test("fires for the Tab-completion path: /team-joi -> /team-join ", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    // User types '/team-joi' and presses Tab. pi-tui's editor expands the
    // text to '/team-join ' (with trailing space) before the next event.
    ctx.editorText = "/team-joi";
    ctx.simulateInput("\t", "/team-join ");
    await flushImmediate();

    const hint = ctx.notifications.find((n) => n.message.includes("Usage: /team-join"));
    expect(hint).toBeDefined();
  });

  test("resets state when user types args, then re-fires after backspacing", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();
    // Type 'd' -- leaves the '/cmd ' state
    ctx.simulateInput("d", "/team-join d");
    await flushImmediate();
    // Backspace twice -- back to '/team-join '
    ctx.simulateInput("\x7f", "/team-join");
    await flushImmediate();
    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();

    const hints = ctx.notifications.filter((n) => n.message.includes("Usage: /team-join"));
    expect(hints).toHaveLength(2);
  });

  test("does not fire for unknown commands", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    ctx.simulateInput(" ", "/unknown-command ");
    await flushImmediate();

    expect(ctx.notifications.filter((n) => n.message.includes("Usage:"))).toHaveLength(0);
  });

  test("fires for all 8 registered commands when their text appears", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    setupHintWatcher(ctx as any, hintRegistry);

    const expectedCommands = ["team-create", "team-join", "team-leave", "team-remove-inactive", "team-send", "team-history", "task-cancel", "task-history"];
    for (const cmd of expectedCommands) {
      // Reset the state between commands so each one re-fires
      ctx.simulateInput("x", "");
      await flushImmediate();
      ctx.simulateInput(" ", `/${cmd} `);
      await flushImmediate();
    }

    for (const cmd of expectedCommands) {
      const hit = ctx.notifications.find((n) => n.message.includes(`Usage: /${cmd}`));
      expect(hit).toBeDefined();
    }
  });

  test("unsubscribe stops further notifications", async () => {
    const { hintRegistry } = setup();
    const ctx = createMockCtx();
    const unsubscribe = setupHintWatcher(ctx as any, hintRegistry);

    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();
    expect(ctx.notifications.filter((n) => n.message.includes("Usage: /team-join"))).toHaveLength(1);

    unsubscribe();

    // Reset state and try again
    ctx.simulateInput("x", "");
    await flushImmediate();
    ctx.simulateInput(" ", "/team-join ");
    await flushImmediate();

    // Still only one hint (the post-unsubscribe input was not handled)
    expect(ctx.notifications.filter((n) => n.message.includes("Usage: /team-join"))).toHaveLength(1);
  });

  test("safe no-op when ctx.ui has no onTerminalInput", () => {
    const ctx = createMockCtx();
    delete (ctx.ui as any).onTerminalInput;
    const unsubscribe = setupHintWatcher(ctx as any, new Map());
    expect(typeof unsubscribe).toBe("function");
    unsubscribe(); // should not throw
  });
});
