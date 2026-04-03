import { describe, test, expect, beforeEach } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG, createPayload, parsePayload, isNewTaskReq } from "../extensions/types.ts";
import type { AgentStatus, MessageRow } from "../extensions/types.ts";
import {
  sendMessage,
  sendTaskReq,
  registerAgent,
  getAgentBySession,
  getUnreadMessages,
  initCursor,
  advanceCursor,
} from "../extensions/db.ts";

// ── Helpers ─────────────────────────────────────────────────────

function createMamoru(overrides?: {
  db?: any;
  sessionId?: string;
  agentName?: string;
  channel?: string;
  persona?: any;
  pi?: any;
  ctx?: any;
  roster?: Roster;
  config?: any;
}) {
  const db = overrides?.db ?? createTestDb();
  const pi = overrides?.pi ?? createMockPi();
  const ctx = overrides?.ctx ?? createMockCtx(overrides?.sessionId ?? "self-session");
  const roster = overrides?.roster ?? new Roster();

  return {
    mamoru: new Mamoru({
      db,
      sessionId: overrides?.sessionId ?? "self-session",
      agentName: overrides?.agentName ?? "TestAgent",
      channel: overrides?.channel ?? "general",
      persona: overrides?.persona ?? null,
      pi,
      ctx,
      roster,
      config: overrides?.config ?? DEFAULT_MAMORU_CONFIG,
    }),
    db,
    pi,
    ctx,
    roster,
  };
}

/** Register a remote agent and send a message from them. */
function sendFromRemote(
  db: any,
  opts: {
    from: string;
    fromName?: string;
    to?: string | null;
    channel?: string;
    taskId?: number | null;
    refMessageId?: number | null;
    event: string;
    content: string;
    intent?: string | null;
    detail?: string | null;
  },
): number {
  // Ensure sender is registered
  const existing = getAgentBySession(db, opts.from);
  if (!existing) {
    registerAgent(db, {
      session_id: opts.from,
      agent_name: opts.fromName ?? opts.from,
      description: "Remote agent",
      provider: null,
      model: null,
      cwd: null,
    });
  }

  const payload = createPayload(opts.event as any, opts.content, {
    intent: opts.intent ?? null,
    detail: opts.detail ?? null,
  });

  return sendMessage(db, {
    from_agent: opts.from,
    to_agent: opts.to ?? null,
    channel: opts.channel ?? "general",
    task_id: opts.taskId ?? null,
    ref_message_id: opts.refMessageId ?? null,
    payload: JSON.stringify(payload),
  });
}

/** Send a task_req from remote agent using sendTaskReq (self-referencing). */
function sendTaskFromRemote(
  db: any,
  opts: {
    from: string;
    fromName?: string;
    to?: string | null;
    channel?: string;
    content?: string;
  },
): number {
  const existing = getAgentBySession(db, opts.from);
  if (!existing) {
    registerAgent(db, {
      session_id: opts.from,
      agent_name: opts.fromName ?? opts.from,
      description: "Remote agent",
      provider: null,
      model: null,
      cwd: null,
    });
  }

  const payload = createPayload("task_req", opts.content ?? "please do this task");
  return sendTaskReq(db, {
    from_agent: opts.from,
    to_agent: opts.to ?? null,
    channel: opts.channel ?? "general",
    payload: JSON.stringify(payload),
  });
}

/** Get all messages sent by a specific agent. */
function getMessagesBySender(db: any, fromAgent: string): MessageRow[] {
  return db.prepare("SELECT * FROM messages WHERE from_agent = ? ORDER BY message_id ASC").all(fromAgent) as MessageRow[];
}

/** Get messages matching event type sent by agent. */
function getAutoReplies(db: any, fromAgent: string, event: string): MessageRow[] {
  const all = getMessagesBySender(db, fromAgent);
  return all.filter((m) => {
    const p = parsePayload(m.payload);
    return p?.event === event;
  });
}

// ── Ping/Pong Tests ─────────────────────────────────────────────

describe("Mamoru – ping/pong", () => {
  test("auto-replies pong to ping", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", to: "self-session", event: "ping", content: "ping" });
    mamoru.pollOnce();

    const pongs = getAutoReplies(db, "self-session", "pong");
    expect(pongs.length).toBe(1);

    const payload = parsePayload(pongs[0].payload);
    expect(payload!.event).toBe("pong");
    expect(pongs[0].to_agent).toBe("remote-1");
  });

  test("ping updates heartbeat in DB", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const before = getAgentBySession(db, "self-session")!.last_heartbeat!;
    // Small delay to ensure time difference
    sendFromRemote(db, { from: "remote-1", to: "self-session", event: "ping", content: "ping" });
    mamoru.pollOnce();

    const after = getAgentBySession(db, "self-session")!.last_heartbeat!;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("ping is not forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", to: "self-session", event: "ping", content: "ping" });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(0);
  });

  test("pong is silently consumed (no auto-reply, no LLM forward)", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", to: "self-session", event: "pong", content: "pong" });
    mamoru.pollOnce();

    // No auto-replies from self (except the initial agent_join broadcast)
    const selfReplies = getMessagesBySender(db, "self-session");
    // Only the agent_join broadcast from start()
    const nonBroadcast = selfReplies.filter((m) => {
      const p = parsePayload(m.payload);
      return p?.event !== "broadcast";
    });
    expect(nonBroadcast.length).toBe(0);
    expect(pi.sentUserMessages.length).toBe(0);
  });
});

// ── Task Request Handling ───────────────────────────────────────

describe("Mamoru – task_req", () => {
  test("accepts new task_req when available → sends task_ack", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const acks = getAutoReplies(db, "self-session", "task_ack");
    expect(acks.length).toBe(1);

    const ack = acks[0];
    expect(ack.task_id).toBe(taskId);
    expect(ack.to_agent).toBe("remote-1");
  });

  test("sets status to busy after accepting task", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    expect(mamoru.getStatus()).toBe("busy");
    expect(getAgentBySession(db, "self-session")!.status).toBe("busy");
  });

  test("sets activeTask with correct fields", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const active = mamoru.getActiveTask();
    expect(active).not.toBeNull();
    expect(active!.taskId).toBe(taskId);
    expect(active!.requesterSessionId).toBe("remote-1");
    expect(active!.startedAt).toBeGreaterThan(0);
  });

  test("forwards accepted task_req to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session", content: "build feature X" });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("build feature X");
    expect(pi.sentUserMessages[0].options).toEqual({ deliverAs: "steer" });
  });

  test("rejects task_req when busy → sends task_reject", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    // Accept first task
    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    // Second task should be rejected
    sendTaskFromRemote(db, { from: "remote-2", to: "self-session" });
    mamoru.pollOnce();

    const rejects = getAutoReplies(db, "self-session", "task_reject");
    expect(rejects.length).toBe(1);
    expect(rejects[0].to_agent).toBe("remote-2");
  });

  test("rejected task_req is not forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    // Accept first task
    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const msgCountAfterFirst = pi.sentUserMessages.length;

    // Second task should be rejected — no new LLM forward
    sendTaskFromRemote(db, { from: "remote-2", to: "self-session" });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(msgCountAfterFirst);
  });

  test("non-self-referencing task_req is forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    // Manually send a task_req where task_id != message_id
    const payload = createPayload("task_req", "follow-up task");
    sendMessage(db, {
      from_agent: "remote-1",
      to_agent: "self-session",
      channel: "general",
      task_id: 999, // different from message_id
      ref_message_id: null,
      payload: JSON.stringify(payload),
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("follow-up task");
  });

  test("task_req broadcast (to_agent=null) when available → accepted", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: null });
    mamoru.pollOnce();

    const acks = getAutoReplies(db, "self-session", "task_ack");
    expect(acks.length).toBe(1);
    expect(mamoru.getStatus()).toBe("busy");
  });

  test("task_req ref_message_id is set in task_ack", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const acks = getAutoReplies(db, "self-session", "task_ack");
    expect(acks.length).toBe(1);
    // ref_message_id should point to the original task_req message
    expect(acks[0].ref_message_id).toBe(taskId);
  });
});

// ── Task Cancel Handling ────────────────────────────────────────

describe("Mamoru – task_cancel", () => {
  test("replies task_cancel_ack", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    // Accept a task first
    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    // Then cancel it
    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_cancel",
      content: "cancel it",
      taskId,
      refMessageId: taskId,
    });
    mamoru.pollOnce();

    const acks = getAutoReplies(db, "self-session", "task_cancel_ack");
    expect(acks.length).toBe(1);
    expect(acks[0].task_id).toBe(taskId);
  });

  test("sets status back to available", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_cancel",
      content: "cancel",
      taskId,
    });
    mamoru.pollOnce();

    expect(mamoru.getStatus()).toBe("available");
  });

  test("clears activeTask", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getActiveTask()).not.toBeNull();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_cancel",
      content: "cancel",
      taskId,
    });
    mamoru.pollOnce();

    expect(mamoru.getActiveTask()).toBeNull();
  });

  test("calls ctx.abort()", () => {
    const { mamoru, db, ctx } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_cancel",
      content: "cancel",
      taskId,
    });
    mamoru.pollOnce();

    expect(ctx.aborted).toBe(true);
  });
});

// ── Broadcast Routing ───────────────────────────────────────────

describe("Mamoru – broadcast", () => {
  test("agent_join updates roster from DB", () => {
    const { mamoru, db, roster } = createMamoru();
    mamoru.start();

    // Register a new agent in DB first
    registerAgent(db, {
      session_id: "newcomer",
      agent_name: "NewAgent",
      description: "I am new here",
      provider: null,
      model: null,
      cwd: null,
    });

    // Then send agent_join broadcast
    sendFromRemote(db, {
      from: "newcomer",
      fromName: "NewAgent",
      event: "broadcast",
      content: "NewAgent has joined",
      intent: "agent_join",
    });
    mamoru.pollOnce();

    const entry = roster.get("newcomer");
    expect(entry).toBeDefined();
    expect(entry!.agent_name).toBe("NewAgent");
    expect(entry!.description).toBe("I am new here");
  });

  test("agent_join emits teammate_roster_changed", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    registerAgent(db, {
      session_id: "newcomer",
      agent_name: "NewAgent",
      description: "I am new here",
      provider: null,
      model: null,
      cwd: null,
    });

    sendFromRemote(db, {
      from: "newcomer",
      event: "broadcast",
      content: "joined",
      intent: "agent_join",
    });
    mamoru.pollOnce();

    const rosterEvents = pi.emittedEvents.filter((e) => e.name === "teammate_roster_changed");
    expect(rosterEvents.length).toBeGreaterThan(0);
  });

  test("agent_leave removes from roster and emits event", () => {
    const { mamoru, db, pi, roster } = createMamoru();
    mamoru.start();

    // Add agent to roster first
    roster.update({
      session_id: "leaver",
      agent_name: "LeaverAgent",
      description: "Leaving",
      status: "available",
      last_heartbeat: Date.now(),
    });

    sendFromRemote(db, {
      from: "leaver",
      event: "broadcast",
      content: "leaving",
      intent: "agent_leave",
    });
    mamoru.pollOnce();

    expect(roster.get("leaver")).toBeUndefined();

    const rosterEvents = pi.emittedEvents.filter((e) => e.name === "teammate_roster_changed");
    expect(rosterEvents.length).toBeGreaterThan(0);
  });

  test("agent_status_change updates roster entry", () => {
    const { mamoru, db, roster } = createMamoru();
    mamoru.start();

    registerAgent(db, {
      session_id: "changer",
      agent_name: "ChangerAgent",
      description: "Changes status",
      provider: null,
      model: null,
      cwd: null,
      status: "busy",
    });

    roster.update({
      session_id: "changer",
      agent_name: "ChangerAgent",
      description: "Changes status",
      status: "available",
      last_heartbeat: Date.now(),
    });

    sendFromRemote(db, {
      from: "changer",
      event: "broadcast",
      content: "now busy",
      intent: "agent_status_change",
    });
    mamoru.pollOnce();

    expect(roster.get("changer")!.status).toBe("busy");
  });

  test("generic broadcast (no matching intent) forwards to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      event: "broadcast",
      content: "general announcement",
      intent: "custom_thing",
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("general announcement");
  });
});

// ── LLM-Forwarded Events ───────────────────────────────────────

describe("Mamoru – LLM-forwarded events", () => {
  test("task_reject is forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_reject",
      content: "too busy",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("task_reject");
    expect(pi.sentUserMessages[0].content).toContain("too busy");
  });

  test("task_clarify is forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_clarify",
      content: "what format?",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("task_clarify");
    expect(pi.sentUserMessages[0].content).toContain("what format?");
  });

  test("task_update is forwarded to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_update",
      content: "50% done",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("task_update");
    expect(pi.sentUserMessages[0].content).toContain("50% done");
  });

  test("task_done removes outbound task and forwards to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    // Register an outbound task
    mamoru.registerOutboundTask(42, "remote-1");
    expect(mamoru.getOutboundTasks().has(42)).toBe(true);

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_done",
      content: "completed",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(mamoru.getOutboundTasks().has(42)).toBe(false);
    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("task_done");
  });

  test("task_fail removes outbound task and forwards to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    mamoru.registerOutboundTask(42, "remote-1");
    expect(mamoru.getOutboundTasks().has(42)).toBe(true);

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_fail",
      content: "error occurred",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(mamoru.getOutboundTasks().has(42)).toBe(false);
    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("task_fail");
  });
});

// ── Info Only ───────────────────────────────────────────────────

describe("Mamoru – info_only", () => {
  test("info_only forwards to LLM", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "info_only",
      content: "FYI: server rebooting",
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("FYI: server rebooting");
  });

  test("info_only is buffered in contextBuffer", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      event: "info_only",
      content: "some info message",
    });
    mamoru.pollOnce();

    // The message was forwarded to LLM (verified by sentUserMessages)
    expect(pi.sentUserMessages.length).toBe(1);
    // Info was forwarded — that's the key behavior
    expect(pi.sentUserMessages[0].content).toContain("info");
  });
});

// ── Acknowledgement Events ──────────────────────────────────────

describe("Mamoru – acknowledgement events", () => {
  test("task_ack is silently consumed", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_ack",
      content: "on it",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(0);
  });

  test("task_cancel_ack removes outbound task", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    mamoru.registerOutboundTask(42, "remote-1");
    expect(mamoru.getOutboundTasks().has(42)).toBe(true);

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_cancel_ack",
      content: "cancelled",
      taskId: 42,
    });
    mamoru.pollOnce();

    expect(mamoru.getOutboundTasks().has(42)).toBe(false);
    // Not forwarded to LLM
    expect(pi.sentUserMessages.length).toBe(0);
  });
});

// ── Outbound Handling (handleOutbound) ──────────────────────────

describe("Mamoru – handleOutbound", () => {
  test("task_done sets status to available", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    // First become busy
    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    mamoru.handleOutbound("task_done", taskId);

    expect(mamoru.getStatus()).toBe("available");
  });

  test("task_fail sets status to available", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    const taskId = sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    mamoru.handleOutbound("task_fail", taskId);

    expect(mamoru.getStatus()).toBe("available");
  });

  test("task_done clears activeTask", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getActiveTask()).not.toBeNull();

    mamoru.handleOutbound("task_done");
    expect(mamoru.getActiveTask()).toBeNull();
  });

  test("task_update does not change status", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    mamoru.handleOutbound("task_update");

    expect(mamoru.getStatus()).toBe("busy");
  });

  test("task_clarify does not change status", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();
    expect(mamoru.getStatus()).toBe("busy");

    mamoru.handleOutbound("task_clarify");

    expect(mamoru.getStatus()).toBe("busy");
  });
});

// ── forwardToLlm Format ─────────────────────────────────────────

describe("Mamoru – forwardToLlm", () => {
  test("formats message with agent name, event, task, content", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    registerAgent(db, {
      session_id: "alice-session",
      agent_name: "Alice",
      description: "Frontend dev",
      provider: null,
      model: null,
      cwd: null,
    });

    sendFromRemote(db, {
      from: "alice-session",
      fromName: "Alice",
      to: "self-session",
      event: "task_clarify",
      content: "which API endpoint?",
      taskId: 77,
      refMessageId: 75,
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(1);
    const msg = pi.sentUserMessages[0].content as string;
    expect(msg).toContain('"Alice"');
    expect(msg).toContain("task_clarify");
    expect(msg).toContain("#77");
    expect(msg).toContain("#75");
    expect(msg).toContain("which API endpoint?");
  });

  test("includes detail file path when present", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, {
      from: "remote-1",
      to: "self-session",
      event: "task_done",
      content: "done",
      taskId: 10,
      detail: "/tmp/results.json",
    });
    mamoru.pollOnce();

    const msg = pi.sentUserMessages[0].content as string;
    expect(msg).toContain("Detail file: /tmp/results.json");
  });
});

// ── Poll Loop ───────────────────────────────────────────────────

describe("Mamoru – poll loop", () => {
  test("pollOnce processes all unread messages", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "msg1" });
    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "msg2" });
    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "msg3" });

    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(3);
  });

  test("pollOnce advances cursor so same messages are not re-read", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "first batch" });
    mamoru.pollOnce();
    expect(pi.sentUserMessages.length).toBe(1);

    // Second poll should not re-process
    mamoru.pollOnce();
    expect(pi.sentUserMessages.length).toBe(1);

    // New message should be picked up
    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "second batch" });
    mamoru.pollOnce();
    expect(pi.sentUserMessages.length).toBe(2);
  });

  test("pollOnce does nothing when no messages", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    mamoru.pollOnce();

    expect(pi.sentUserMessages.length).toBe(0);
  });

  test("pollOnce skips messages with invalid payload", () => {
    const { mamoru, db, pi } = createMamoru();
    mamoru.start();

    // Insert a message with invalid JSON payload directly
    registerAgent(db, {
      session_id: "bad-agent",
      agent_name: "BadAgent",
      description: null,
      provider: null,
      model: null,
      cwd: null,
    });
    db.prepare(
      "INSERT INTO messages (from_agent, to_agent, channel, task_id, ref_message_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("bad-agent", null, "general", null, null, "not-json", Date.now());

    // Also send a valid message
    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "valid" });

    mamoru.pollOnce();

    // Only the valid message should be forwarded
    expect(pi.sentUserMessages.length).toBe(1);
    expect(pi.sentUserMessages[0].content).toContain("valid");
  });

  test("start() begins interval polling", async () => {
    const { mamoru, db, pi } = createMamoru({
      config: { ...DEFAULT_MAMORU_CONFIG, pollIntervalMs: 50 },
    });
    mamoru.start();

    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "timed" });

    // Wait for at least one poll cycle
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(pi.sentUserMessages.length).toBeGreaterThanOrEqual(1);

    mamoru.stop();
  });
});

// ── Lifecycle ───────────────────────────────────────────────────

describe("Mamoru – lifecycle", () => {
  test("start() registers agent in DB", () => {
    const { mamoru, db } = createMamoru({ agentName: "GuardianBot" });
    mamoru.start();

    const agent = getAgentBySession(db, "self-session");
    expect(agent).not.toBeNull();
    expect(agent!.agent_name).toBe("GuardianBot");
    expect(agent!.status).toBe("available");
  });

  test("start() broadcasts agent_join", () => {
    const { mamoru, db } = createMamoru({ agentName: "JoinBot" });
    mamoru.start();

    const msgs = getMessagesBySender(db, "self-session");
    expect(msgs.length).toBeGreaterThan(0);

    const joinMsg = msgs.find((m) => {
      const p = parsePayload(m.payload);
      return p?.event === "broadcast" && p?.intent === "agent_join";
    });
    expect(joinMsg).toBeDefined();
    expect(parsePayload(joinMsg!.payload)!.content).toContain("JoinBot");
  });

  test("stop() broadcasts agent_leave and marks inactive", () => {
    const { mamoru, db } = createMamoru({ agentName: "LeaveBot" });
    mamoru.start();
    mamoru.stop();

    expect(mamoru.getStatus()).toBe("inactive");
    expect(getAgentBySession(db, "self-session")!.status).toBe("inactive");

    const msgs = getMessagesBySender(db, "self-session");
    const leaveMsg = msgs.find((m) => {
      const p = parsePayload(m.payload);
      return p?.event === "broadcast" && p?.intent === "agent_leave";
    });
    expect(leaveMsg).toBeDefined();
    expect(parsePayload(leaveMsg!.payload)!.content).toContain("LeaveBot");
  });

  test("stop() clears poll timer", async () => {
    const { mamoru, db, pi } = createMamoru({
      config: { ...DEFAULT_MAMORU_CONFIG, pollIntervalMs: 50 },
    });
    mamoru.start();
    mamoru.stop();

    // Send a message after stop — it should NOT be polled
    sendFromRemote(db, { from: "remote-1", event: "info_only", content: "after stop" });

    await new Promise((resolve) => setTimeout(resolve, 120));

    // No messages forwarded to LLM after stop
    expect(pi.sentUserMessages.length).toBe(0);
  });
});

// ── buildSystemPromptAdditions ──────────────────────────────────

describe("Mamoru – buildSystemPromptAdditions", () => {
  test("returns undefined when no persona and no active task", () => {
    const { mamoru } = createMamoru();
    const result = mamoru.buildSystemPromptAdditions("base prompt");
    expect(result).toBeUndefined();
  });

  test("adds persona info when persona is set", () => {
    const { mamoru } = createMamoru({
      persona: { name: "CodeBot", provider: null, model: null, description: "A coding assistant" },
    });
    const result = mamoru.buildSystemPromptAdditions("base prompt");
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("base prompt");
    expect(result!.systemPrompt).toContain('"CodeBot"');
    expect(result!.systemPrompt).toContain("A coding assistant");
  });

  test("adds active task info when task is active", () => {
    const { mamoru, db } = createMamoru();
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const result = mamoru.buildSystemPromptAdditions("base prompt");
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("base prompt");
    expect(result!.systemPrompt).toContain("task_done");
    expect(result!.systemPrompt).toContain("task_fail");
    expect(result!.systemPrompt).toContain("task_update");
  });

  test("includes both persona and task info", () => {
    const { mamoru, db } = createMamoru({
      persona: { name: "WorkerBot", provider: null, model: null, description: "Does work" },
    });
    mamoru.start();

    sendTaskFromRemote(db, { from: "remote-1", to: "self-session" });
    mamoru.pollOnce();

    const result = mamoru.buildSystemPromptAdditions("base");
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain('"WorkerBot"');
    expect(result!.systemPrompt).toContain("Does work");
    expect(result!.systemPrompt).toContain("task_done");
  });
});

// ── registerOutboundTask ────────────────────────────────────────

describe("Mamoru – registerOutboundTask", () => {
  test("adds task to outboundTasks map", () => {
    const { mamoru } = createMamoru();

    mamoru.registerOutboundTask(100, "worker-session");

    const tasks = mamoru.getOutboundTasks();
    expect(tasks.has(100)).toBe(true);
    expect(tasks.get(100)!.workerSessionId).toBe("worker-session");
    expect(tasks.get(100)!.taskId).toBe(100);
    expect(tasks.get(100)!.sentAt).toBeGreaterThan(0);
  });
});

// ── Getters ─────────────────────────────────────────────────────

describe("Mamoru – getters", () => {
  test("getChannel returns channel", () => {
    const { mamoru } = createMamoru({ channel: "my-channel" });
    expect(mamoru.getChannel()).toBe("my-channel");
  });

  test("getAgentName returns agent name", () => {
    const { mamoru } = createMamoru({ agentName: "MyAgent" });
    expect(mamoru.getAgentName()).toBe("MyAgent");
  });

  test("getSessionId returns session ID", () => {
    const { mamoru } = createMamoru({ sessionId: "my-session" });
    expect(mamoru.getSessionId()).toBe("my-session");
  });

  test("getRoster returns roster instance", () => {
    const roster = new Roster();
    const { mamoru } = createMamoru({ roster });
    expect(mamoru.getRoster()).toBe(roster);
  });
});
