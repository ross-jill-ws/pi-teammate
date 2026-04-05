import { describe, test, expect, beforeEach } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG, parsePayload } from "../extensions/types.ts";
import type { MessageRow } from "../extensions/types.ts";
import { registerAgent } from "../extensions/db.ts";
import { createSendMessageTool } from "../extensions/tools/send-message.ts";

// ── Helpers ─────────────────────────────────────────────────────

function setup(overrides?: { sessionId?: string; channel?: string }) {
  const db = createTestDb();
  const pi = createMockPi();
  const sessionId = overrides?.sessionId ?? "self-session";
  const channel = overrides?.channel ?? "general";
  const ctx = createMockCtx(sessionId);
  const roster = new Roster();

  const mamoru = new Mamoru({
    db,
    sessionId,
    agentName: "TestAgent",
    channel,
    persona: null,
    pi: pi as any,
    ctx: ctx as any,
    roster,
    config: DEFAULT_MAMORU_CONFIG,
  });

  mamoru.start();

  // Register a remote agent in DB and roster
  registerAgent(db, {
    session_id: "remote-1",
    agent_name: "RemoteAgent",
    description: "A remote helper",
    provider: null,
    model: null,
    cwd: null,
  });
  roster.update({
    session_id: "remote-1",
    agent_name: "RemoteAgent",
    description: "A remote helper",
    status: "available",
    last_heartbeat: Date.now(),
  });

  const sendMessage = createSendMessageTool({
    getMamoru: () => mamoru,
    getDb: () => db,
  });

  return { db, pi, ctx, mamoru, roster, sendMessage, sessionId, channel };
}

function getRow(db: any, messageId: number): MessageRow {
  return db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageRow;
}

const dummyCtx = createMockCtx("dummy") as any;

// ── task_req via send_message Tests ─────────────────────────────

describe("send_message with task_req", () => {
  test("inserts task_req message into DB", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "do something" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row).toBeDefined();
    const payload = parsePayload(row.payload);
    expect(payload!.event).toBe("task_req");
  });

  test("sets from_agent to own session_id", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "do something" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row.from_agent).toBe("self-session");
  });

  test("sets to_agent to target session_id", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "do something" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row.to_agent).toBe("remote-1");
  });

  test("sets task_id equal to the new message_id (self-referencing)", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "do something" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row.task_id).toBe(row.message_id);
  });

  test("sets ref_message_id to NULL for new task", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "do something" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row.ref_message_id).toBeNull();
  });

  test("payload has event=task_req and need_reply=true", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "build it" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    const payload = parsePayload(row.payload);
    expect(payload!.event).toBe("task_req");
    expect(payload!.need_reply).toBe(true);
  });

  test("returns message_id (= task_id) in result for correlation", async () => {
    const { sendMessage } = setup();
    const result = await sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: "build it" }, undefined, undefined, dummyCtx);
    const taskId = (result as any).details.taskId;
    expect(typeof taskId).toBe("number");
    expect(taskId).toBeGreaterThan(0);
    const text = (result as any).content[0].text;
    expect(text).toContain(`Task #${taskId}`);
  });

  test("rejects if target agent not in roster", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute("tc1", { to: "unknown-agent", event: "task_req", content: "build it" }, undefined, undefined, dummyCtx),
    ).rejects.toThrow('Agent "unknown-agent" not found in roster.');
  });

  test("rejects if content exceeds 20 words", async () => {
    const { sendMessage } = setup();
    const longTask = Array(21).fill("word").join(" ");
    expect(
      sendMessage.execute("tc1", { to: "remote-1", event: "task_req", content: longTask }, undefined, undefined, dummyCtx),
    ).rejects.toThrow("exceeds 20 words");
  });

  test("rejects if no 'to' recipient", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute("tc1", { event: "task_req", content: "build it" }, undefined, undefined, dummyCtx),
    ).rejects.toThrow("task_req requires a 'to' recipient");
  });

  test("rejects self-delegation", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute("tc1", { to: "self-session", event: "task_req", content: "build it" }, undefined, undefined, dummyCtx),
    ).rejects.toThrow("Cannot send a task_req to yourself");
  });

  test("sets intent from optional intent parameter", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_req", content: "review this", intent: "code_review" },
      undefined, undefined, dummyCtx,
    );
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    const payload = parsePayload(row.payload);
    expect(payload!.intent).toBe("code_review");
  });

  test("sets detail from optional detail parameter", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_req", content: "check file", detail: "/tmp/spec.md" },
      undefined, undefined, dummyCtx,
    );
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    const payload = parsePayload(row.payload);
    expect(payload!.detail).toBe("/tmp/spec.md");
  });

  test("task_req does not require task_id parameter (auto-set)", async () => {
    const { sendMessage, db } = setup();
    // task_req should work without explicitly passing task_id
    const result = await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_req", content: "do work" },
      undefined, undefined, dummyCtx,
    );
    const taskId = (result as any).details.taskId;
    const row = getRow(db, taskId);
    expect(row.task_id).toBe(row.message_id);
  });
});

// ── send_message (non-task_req) Tests ───────────────────────────

describe("send_message", () => {
  test("inserts message with specified event type into DB", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_done", task_id: 1, content: "all done" },
      undefined, undefined, dummyCtx,
    );
    const msgId = (result as any).details.messageId;
    const row = getRow(db, msgId);
    const payload = parsePayload(row.payload);
    expect(payload!.event).toBe("task_done");
  });

  test("validates event is a known MessageEvent", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute(
        "tc1",
        { event: "unknown_event", content: "test" },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow('Unknown event "unknown_event"');
  });

  test("sets task_id from parameter for task-related events", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_update", task_id: 42, content: "progress" },
      undefined, undefined, dummyCtx,
    );
    const msgId = (result as any).details.messageId;
    const row = getRow(db, msgId);
    expect(row.task_id).toBe(42);
  });

  test("requires task_id for task_done", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute(
        "tc1",
        { to: "remote-1", event: "task_done", content: "done" },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow('Event "task_done" requires a task_id.');
  });

  test("requires task_id for task_fail", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute(
        "tc1",
        { to: "remote-1", event: "task_fail", content: "failed" },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow('Event "task_fail" requires a task_id.');
  });

  test("requires task_id for task_update", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute(
        "tc1",
        { to: "remote-1", event: "task_update", content: "progress" },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow('Event "task_update" requires a task_id.');
  });

  test("requires task_id for task_clarify", async () => {
    const { sendMessage } = setup();
    expect(
      sendMessage.execute(
        "tc1",
        { to: "remote-1", event: "task_clarify", content: "what?" },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow('Event "task_clarify" requires a task_id.');
  });

  test("MAMORU intercepts outbound task_done and sets status to available", async () => {
    const { sendMessage, mamoru, db } = setup();
    const { sendTaskReq } = await import("../extensions/db.ts");
    const { createPayload: cp } = await import("../extensions/types.ts");

    const taskPayload = cp("task_req", "do work", { need_reply: true });
    const taskReqId = sendTaskReq(db, {
      from_agent: "remote-1",
      to_agent: "self-session",
      channel: "general",
      payload: JSON.stringify(taskPayload),
    });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_done", task_id: taskReqId, content: "completed" },
      undefined, undefined, dummyCtx,
    );

    expect(mamoru.getStatus()).toBe("available");
  });

  test("MAMORU intercepts outbound task_fail and sets status to available", async () => {
    const { sendMessage, mamoru, db } = setup();
    const { sendTaskReq } = await import("../extensions/db.ts");
    const { createPayload: cp } = await import("../extensions/types.ts");

    const taskPayload = cp("task_req", "do work", { need_reply: true });
    const taskReqId = sendTaskReq(db, {
      from_agent: "remote-1",
      to_agent: "self-session",
      channel: "general",
      payload: JSON.stringify(taskPayload),
    });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_fail", task_id: taskReqId, content: "error" },
      undefined, undefined, dummyCtx,
    );

    expect(mamoru.getStatus()).toBe("available");
  });

  test("MAMORU does not change status for task_update", async () => {
    const { sendMessage, mamoru, db } = setup();
    const { sendTaskReq } = await import("../extensions/db.ts");
    const { createPayload: cp } = await import("../extensions/types.ts");

    const taskPayload = cp("task_req", "do work", { need_reply: true });
    const taskReqId = sendTaskReq(db, {
      from_agent: "remote-1",
      to_agent: "self-session",
      channel: "general",
      payload: JSON.stringify(taskPayload),
    });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    await sendMessage.execute(
      "tc1",
      { to: "remote-1", event: "task_update", task_id: taskReqId, content: "50% done" },
      undefined, undefined, dummyCtx,
    );

    expect(mamoru.getStatus()).toBe("busy");
  });

  test("allows broadcast (to_agent omitted, to_agent=null)", async () => {
    const { sendMessage, db } = setup();
    const result = await sendMessage.execute(
      "tc1",
      { event: "broadcast", content: "hello team" },
      undefined, undefined, dummyCtx,
    );
    const msgId = (result as any).details.messageId;
    const row = getRow(db, msgId);
    expect(row.to_agent).toBeNull();
    const payload = parsePayload(row.payload);
    expect(payload!.event).toBe("broadcast");
  });

  test("validates content <= 20 words", async () => {
    const { sendMessage } = setup();
    const longContent = Array(21).fill("word").join(" ");
    expect(
      sendMessage.execute(
        "tc1",
        { event: "broadcast", content: longContent },
        undefined, undefined, dummyCtx,
      ),
    ).rejects.toThrow("exceeds 20 words");
  });
});
