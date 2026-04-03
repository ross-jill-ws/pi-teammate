import { describe, test, expect } from "bun:test";
import { createTestDb } from "./helpers/mock-pi.ts";
import {
  registerAgent,
  updateAgentStatus,
  updateHeartbeat,
  getActiveAgents,
  getAgentBySession,
  getAgentByName,
  sendMessage,
  sendTaskReq,
  initCursor,
  advanceCursor,
  getUnreadMessages,
  getMessagesByTaskId,
} from "../extensions/db.ts";
import { createPayload } from "../extensions/types.ts";

function makePayload(content: string = "hello") {
  return JSON.stringify(createPayload("broadcast", content));
}

function makeTaskPayload(content: string = "do this task") {
  return JSON.stringify(createPayload("task_req", content));
}

// ── Agent Functions ─────────────────────────────────────────────

describe("registerAgent", () => {
  test("inserts a new agent", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "alice",
      description: "Test agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      cwd: "/tmp",
    });

    const agent = getAgentBySession(db, "s1");
    expect(agent).not.toBeNull();
    expect(agent!.agent_name).toBe("alice");
    expect(agent!.status).toBe("available");
    expect(agent!.description).toBe("Test agent");
    expect(agent!.provider).toBe("anthropic");
    expect(agent!.model).toBe("claude-sonnet-4-5");
    expect(agent!.cwd).toBe("/tmp");
    expect(agent!.last_heartbeat).toBeGreaterThan(0);
  });

  test("upserts on conflict (INSERT OR REPLACE)", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "alice",
      description: "v1",
      provider: null,
      model: null,
      cwd: null,
    });
    registerAgent(db, {
      session_id: "s1",
      agent_name: "alice-v2",
      description: "v2",
      provider: "openai",
      model: "gpt-4",
      cwd: "/home",
    });

    const agents = getActiveAgents(db);
    expect(agents.length).toBe(1);
    expect(agents[0].agent_name).toBe("alice-v2");
    expect(agents[0].description).toBe("v2");
  });

  test("defaults status to available", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "bob",
      description: null,
      provider: null,
      model: null,
      cwd: null,
    });

    const agent = getAgentBySession(db, "s1");
    expect(agent!.status).toBe("available");
  });

  test("allows custom status", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "bob",
      description: null,
      provider: null,
      model: null,
      cwd: null,
      status: "busy",
    });

    const agent = getAgentBySession(db, "s1");
    expect(agent!.status).toBe("busy");
  });
});

describe("updateAgentStatus", () => {
  test("updates agent status", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "alice",
      description: null,
      provider: null,
      model: null,
      cwd: null,
    });

    updateAgentStatus(db, "s1", "busy");
    expect(getAgentBySession(db, "s1")!.status).toBe("busy");

    updateAgentStatus(db, "s1", "inactive");
    expect(getAgentBySession(db, "s1")!.status).toBe("inactive");
  });
});

describe("updateHeartbeat", () => {
  test("sets last_heartbeat to current time", () => {
    const db = createTestDb();
    registerAgent(db, {
      session_id: "s1",
      agent_name: "alice",
      description: null,
      provider: null,
      model: null,
      cwd: null,
    });

    const before = Date.now();
    updateHeartbeat(db, "s1");
    const after = Date.now();

    const agent = getAgentBySession(db, "s1");
    expect(agent!.last_heartbeat).toBeGreaterThanOrEqual(before);
    expect(agent!.last_heartbeat).toBeLessThanOrEqual(after);
  });
});

describe("getActiveAgents", () => {
  test("returns agents where status != inactive", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "a1", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "a2", description: null, provider: null, model: null, cwd: null, status: "busy" });
    registerAgent(db, { session_id: "s3", agent_name: "a3", description: null, provider: null, model: null, cwd: null, status: "inactive" });

    const active = getActiveAgents(db);
    expect(active.length).toBe(2);
    const names = active.map((a) => a.agent_name);
    expect(names).toContain("a1");
    expect(names).toContain("a2");
    expect(names).not.toContain("a3");
  });

  test("returns empty array when no agents", () => {
    const db = createTestDb();
    expect(getActiveAgents(db)).toEqual([]);
  });
});

describe("getAgentBySession", () => {
  test("returns agent by session_id", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    expect(getAgentBySession(db, "s1")!.agent_name).toBe("alice");
  });

  test("returns null for non-existent session", () => {
    const db = createTestDb();
    expect(getAgentBySession(db, "nonexistent")).toBeNull();
  });
});

describe("getAgentByName", () => {
  test("returns agent by name", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    expect(getAgentByName(db, "alice")!.session_id).toBe("s1");
  });

  test("returns null for non-existent name", () => {
    const db = createTestDb();
    expect(getAgentByName(db, "nobody")).toBeNull();
  });
});

// ── Message Functions ───────────────────────────────────────────

describe("sendMessage", () => {
  test("inserts a message and returns message_id", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    const id = sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("hi everyone"),
    });

    expect(id).toBeGreaterThan(0);

    const msg = db.prepare("SELECT * FROM messages WHERE message_id = ?").get(id) as any;
    expect(msg.from_agent).toBe("s1");
    expect(msg.channel).toBe("general");
    expect(msg.to_agent).toBeNull();
    expect(msg.created_at).toBeGreaterThan(0);
  });

  test("rejects invalid JSON payload", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    expect(() =>
      sendMessage(db, {
        from_agent: "s1",
        to_agent: null,
        channel: "general",
        task_id: null,
        ref_message_id: null,
        payload: "not json",
      }),
    ).toThrow("payload must be valid JSON");
  });

  test("rejects payload without content field", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    expect(() =>
      sendMessage(db, {
        from_agent: "s1",
        to_agent: null,
        channel: "general",
        task_id: null,
        ref_message_id: null,
        payload: JSON.stringify({ event: "broadcast" }),
      }),
    ).toThrow("payload must have a content field");
  });

  test("rejects payload with content > 500 chars", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    const longContent = "x".repeat(501);
    expect(() =>
      sendMessage(db, {
        from_agent: "s1",
        to_agent: null,
        channel: "general",
        task_id: null,
        ref_message_id: null,
        payload: JSON.stringify(createPayload("broadcast", longContent)),
      }),
    ).toThrow("payload.content must be ≤ 500 characters");
  });

  test("accepts payload with exactly 500 char content", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    const content500 = "x".repeat(500);
    const id = sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(createPayload("broadcast", content500)),
    });

    expect(id).toBeGreaterThan(0);
  });

  test("increments message_id", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    const id1 = sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("msg1"),
    });
    const id2 = sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("msg2"),
    });

    expect(id2).toBe(id1 + 1);
  });
});

describe("sendTaskReq", () => {
  test("creates self-referencing task message", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    const taskId = sendTaskReq(db, {
      from_agent: "s1",
      to_agent: "s2",
      channel: "general",
      payload: makeTaskPayload("build feature X"),
    });

    expect(taskId).toBeGreaterThan(0);

    const msg = db.prepare("SELECT * FROM messages WHERE message_id = ?").get(taskId) as any;
    expect(msg.task_id).toBe(taskId); // self-referencing
    expect(msg.from_agent).toBe("s1");
    expect(msg.to_agent).toBe("s2");
    expect(msg.ref_message_id).toBeNull();
  });

  test("task_id equals message_id", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    const taskId = sendTaskReq(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      payload: makeTaskPayload(),
    });

    const msgs = getMessagesByTaskId(db, taskId);
    expect(msgs.length).toBe(1);
    expect(msgs[0].message_id).toBe(taskId);
    expect(msgs[0].task_id).toBe(taskId);
  });
});

// ── Cursor Functions ────────────────────────────────────────────

describe("initCursor", () => {
  test("creates cursor with last_read_id = 0", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    const cursor = db.prepare(
      "SELECT * FROM agent_cursors WHERE session_id = ? AND channel = ?",
    ).get("s1", "general") as any;

    expect(cursor).toBeTruthy();
    expect(cursor.last_read_id).toBe(0);
  });

  test("does not overwrite existing cursor (ON CONFLICT DO NOTHING)", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");
    advanceCursor(db, "s1", "general", 42);
    initCursor(db, "s1", "general"); // should not reset

    const cursor = db.prepare(
      "SELECT * FROM agent_cursors WHERE session_id = ? AND channel = ?",
    ).get("s1", "general") as any;

    expect(cursor.last_read_id).toBe(42);
  });

  test("skips to max message_id when channel has existing messages", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    // Bob sends messages BEFORE alice joins
    sendMessage(db, {
      from_agent: "s2", to_agent: null, channel: "general",
      task_id: null, ref_message_id: null,
      payload: makePayload("old message 1"),
    });
    sendMessage(db, {
      from_agent: "s2", to_agent: null, channel: "general",
      task_id: null, ref_message_id: null,
      payload: makePayload("old message 2"),
    });

    // Now alice joins — cursor should skip past existing messages
    initCursor(db, "s1", "general");

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(0); // should NOT see old messages

    // New message after join should be visible
    sendMessage(db, {
      from_agent: "s2", to_agent: null, channel: "general",
      task_id: null, ref_message_id: null,
      payload: makePayload("new message after join"),
    });

    const unread2 = getUnreadMessages(db, "s1", "general");
    expect(unread2.length).toBe(1);
    expect(unread2[0].payload).toContain("new message after join");
  });
});

describe("advanceCursor", () => {
  test("upserts cursor value", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    // Upsert without prior initCursor
    advanceCursor(db, "s1", "general", 10);

    const cursor = db.prepare(
      "SELECT * FROM agent_cursors WHERE session_id = ? AND channel = ?",
    ).get("s1", "general") as any;
    expect(cursor.last_read_id).toBe(10);

    // Update existing
    advanceCursor(db, "s1", "general", 25);
    const cursor2 = db.prepare(
      "SELECT * FROM agent_cursors WHERE session_id = ? AND channel = ?",
    ).get("s1", "general") as any;
    expect(cursor2.last_read_id).toBe(25);
  });
});

// ── Unread Messages ─────────────────────────────────────────────

describe("getUnreadMessages", () => {
  test("returns messages after cursor, excluding own messages", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    // Bob sends a broadcast
    sendMessage(db, {
      from_agent: "s2",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("hi from bob"),
    });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(1);
    expect(unread[0].from_agent).toBe("s2");
  });

  test("excludes own messages", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("my own message"),
    });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(0);
  });

  test("includes broadcasts (to_agent IS NULL)", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    sendMessage(db, {
      from_agent: "s2",
      to_agent: null, // broadcast
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("broadcast msg"),
    });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(1);
  });

  test("includes DMs to self", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    sendMessage(db, {
      from_agent: "s2",
      to_agent: "s1", // DM to alice
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("dm to alice"),
    });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(1);
    expect(unread[0].to_agent).toBe("s1");
  });

  test("excludes DMs to others", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s3", agent_name: "carol", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    // Bob sends DM to Carol
    sendMessage(db, {
      from_agent: "s2",
      to_agent: "s3", // DM to carol, not alice
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("dm to carol"),
    });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(0);
  });

  test("respects cursor position", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    const id1 = sendMessage(db, {
      from_agent: "s2",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("msg1"),
    });

    sendMessage(db, {
      from_agent: "s2",
      to_agent: null,
      channel: "general",
      task_id: null,
      ref_message_id: null,
      payload: makePayload("msg2"),
    });

    // Advance cursor past first message
    advanceCursor(db, "s1", "general", id1);

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(1);

    const parsed = JSON.parse(unread[0].payload);
    expect(parsed.content).toBe("msg2");
  });

  test("returns messages ordered by message_id ASC", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");

    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "general", task_id: null, ref_message_id: null, payload: makePayload("first") });
    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "general", task_id: null, ref_message_id: null, payload: makePayload("second") });
    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "general", task_id: null, ref_message_id: null, payload: makePayload("third") });

    const unread = getUnreadMessages(db, "s1", "general");
    expect(unread.length).toBe(3);
    expect(unread[0].message_id).toBeLessThan(unread[1].message_id);
    expect(unread[1].message_id).toBeLessThan(unread[2].message_id);
  });

  test("returns empty when no cursor exists (defaults to 0)", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    // No initCursor call — cursor defaults to 0
    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "general", task_id: null, ref_message_id: null, payload: makePayload("msg") });

    const unread = getUnreadMessages(db, "s1", "general");
    // Should still return messages (cursor defaults to 0 in the query)
    expect(unread.length).toBe(1);
  });

  test("only returns messages for the specified channel", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    initCursor(db, "s1", "general");
    initCursor(db, "s1", "private");

    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "general", task_id: null, ref_message_id: null, payload: makePayload("in general") });
    sendMessage(db, { from_agent: "s2", to_agent: null, channel: "private", task_id: null, ref_message_id: null, payload: makePayload("in private") });

    const generalMsgs = getUnreadMessages(db, "s1", "general");
    expect(generalMsgs.length).toBe(1);
    expect(JSON.parse(generalMsgs[0].payload).content).toBe("in general");

    const privateMsgs = getUnreadMessages(db, "s1", "private");
    expect(privateMsgs.length).toBe(1);
    expect(JSON.parse(privateMsgs[0].payload).content).toBe("in private");
  });
});

// ── Task Message Retrieval ──────────────────────────────────────

describe("getMessagesByTaskId", () => {
  test("returns all messages for a task", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    // Create task
    const taskId = sendTaskReq(db, {
      from_agent: "s1",
      to_agent: "s2",
      channel: "general",
      payload: makeTaskPayload("build X"),
    });

    // Bob sends task_ack
    sendMessage(db, {
      from_agent: "s2",
      to_agent: "s1",
      channel: "general",
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(createPayload("task_ack", "on it")),
    });

    // Bob sends task_done
    sendMessage(db, {
      from_agent: "s2",
      to_agent: "s1",
      channel: "general",
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(createPayload("task_done", "done")),
    });

    const msgs = getMessagesByTaskId(db, taskId);
    expect(msgs.length).toBe(3);
    expect(msgs[0].message_id).toBe(taskId); // task_req
    expect(msgs[0].task_id).toBe(taskId);
    expect(msgs[1].task_id).toBe(taskId);
    expect(msgs[2].task_id).toBe(taskId);
  });

  test("returns messages ordered by message_id ASC", () => {
    const db = createTestDb();
    registerAgent(db, { session_id: "s1", agent_name: "alice", description: null, provider: null, model: null, cwd: null });
    registerAgent(db, { session_id: "s2", agent_name: "bob", description: null, provider: null, model: null, cwd: null });

    const taskId = sendTaskReq(db, {
      from_agent: "s1",
      to_agent: "s2",
      channel: "general",
      payload: makeTaskPayload("task"),
    });

    sendMessage(db, {
      from_agent: "s2",
      to_agent: "s1",
      channel: "general",
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(createPayload("task_update", "progress")),
    });

    const msgs = getMessagesByTaskId(db, taskId);
    expect(msgs[0].message_id).toBeLessThan(msgs[1].message_id);
  });

  test("returns empty array for non-existent task", () => {
    const db = createTestDb();
    expect(getMessagesByTaskId(db, 9999)).toEqual([]);
  });
});
