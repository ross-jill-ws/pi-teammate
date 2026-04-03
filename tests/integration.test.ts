import { describe, test, expect, afterEach } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import {
  DEFAULT_MAMORU_CONFIG,
  createPayload,
  parsePayload,
  type MessageRow,
} from "../extensions/types.ts";
import {
  sendMessage,
  sendTaskReq,
  getAgentBySession,
  getMessagesByTaskId,
} from "../extensions/db.ts";

// ── Helpers ─────────────────────────────────────────────────────

const CHANNEL = "test-channel";

function createSharedDb() {
  return createTestDb();
}

function createAgent(db: any, sessionId: string, name: string, description: string) {
  const pi = createMockPi();
  const ctx = createMockCtx(sessionId);
  const roster = new Roster();
  const mamoru = new Mamoru({
    db,
    sessionId,
    agentName: name,
    channel: CHANNEL,
    persona: { name, description, provider: null, model: null },
    pi: pi as any,
    ctx: ctx as any,
    roster,
    config: { ...DEFAULT_MAMORU_CONFIG, pollIntervalMs: 50 },
  });
  return { pi, ctx, roster, mamoru };
}

/** Get all messages from a sender with a specific event type. */
function getMessagesByEvent(db: any, fromAgent: string, event: string): MessageRow[] {
  const all = db
    .prepare("SELECT * FROM messages WHERE from_agent = ? ORDER BY message_id ASC")
    .all(fromAgent) as MessageRow[];
  return all.filter((m: MessageRow) => {
    const p = parsePayload(m.payload);
    return p?.event === event;
  });
}

/** Get all messages with a specific event type in the channel. */
function getAllMessagesByEvent(db: any, event: string): MessageRow[] {
  const all = db
    .prepare("SELECT * FROM messages ORDER BY message_id ASC")
    .all() as MessageRow[];
  return all.filter((m: MessageRow) => {
    const p = parsePayload(m.payload);
    return p?.event === event;
  });
}

// ── Agent Discovery ─────────────────────────────────────────────

describe("agent discovery", () => {
  test("agent A joins, agent B joins, both see each other in roster", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Planner");
    const b = createAgent(db, "sess-b", "Agent B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // B polls and sees A's agent_join broadcast
    b.mamoru.pollOnce();
    expect(b.roster.getAll().length).toBe(1);
    expect(b.roster.getAll()[0].agent_name).toBe("Agent A");

    // A polls and sees B's agent_join broadcast
    a.mamoru.pollOnce();
    expect(a.roster.getAll().length).toBe(1);
    expect(a.roster.getAll()[0].agent_name).toBe("Agent B");

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });

  test("agent C joins late and sees A and B in roster", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Planner");
    const b = createAgent(db, "sess-b", "Agent B", "Developer");

    // A and B start first
    a.mamoru.start();
    b.mamoru.start();

    // Let A and B discover each other
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // C joins late
    const c = createAgent(db, "sess-c", "Agent C", "Tester");
    c.mamoru.start();

    // C polls — should see both A and B
    // Roster.initFromDb loads all agents on start(), so C's roster
    // should already have A and B from the DB
    expect(c.roster.getAll().length).toBe(2);

    const names = c.roster.getAll().map((e) => e.agent_name).sort();
    expect(names).toEqual(["Agent A", "Agent B"]);

    // A and B poll to see C's join
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    expect(a.roster.get("sess-c")?.agent_name).toBe("Agent C");
    expect(b.roster.get("sess-c")?.agent_name).toBe("Agent C");

    a.mamoru.stop();
    b.mamoru.stop();
    c.mamoru.stop();
    db.close();
  });

  test("agent A leaves, B sees A removed from roster", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Planner");
    const b = createAgent(db, "sess-b", "Agent B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Both poll to discover each other
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    expect(b.roster.get("sess-a")).toBeDefined();

    // A leaves — this broadcasts agent_leave
    a.mamoru.stop();

    // B polls and should see A removed from roster
    b.mamoru.pollOnce();

    expect(b.roster.get("sess-a")).toBeUndefined();
    expect(b.roster.getAll().length).toBe(0);

    // A should be marked inactive in DB
    const agentA = getAgentBySession(db, "sess-a");
    expect(agentA!.status).toBe("inactive");

    b.mamoru.stop();
    db.close();
  });
});

// ── Task Delegation Flow ────────────────────────────────────────

describe("task delegation flow", () => {
  test("A sends task_req to B, B auto-acks, B status becomes busy", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "A", "Planner");
    const b = createAgent(db, "sess-b", "B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover each other
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A sends task_req to B
    const taskPayload = createPayload("task_req", "Review the code", { need_reply: true });
    const msgId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayload),
    });

    // B polls — should auto-ack
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");
    expect(b.mamoru.getActiveTask()).not.toBeNull();
    expect(b.mamoru.getActiveTask()!.taskId).toBe(msgId);
    expect(b.mamoru.getActiveTask()!.requesterSessionId).toBe("sess-a");

    // Check DB for task_ack message from B
    const acks = getMessagesByEvent(db, "sess-b", "task_ack");
    expect(acks.length).toBe(1);
    expect(acks[0].task_id).toBe(msgId);
    expect(acks[0].to_agent).toBe("sess-a");

    // A polls — should see task_ack forwarded
    // Note: task_ack is silently consumed (not forwarded to LLM)
    a.mamoru.pollOnce();
    // task_ack is not forwarded to LLM per mamoru.ts processMessage
    // But B's task_req acceptance is verified above

    // B should have received the task content forwarded to its LLM
    expect(b.pi.sentUserMessages.length).toBe(1);
    expect(b.pi.sentUserMessages[0].content).toContain("Review the code");

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });

  test("B sends task_done, B status becomes available, A receives result", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "A", "Planner");
    const b = createAgent(db, "sess-b", "B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A sends task_req to B
    const taskPayload = createPayload("task_req", "Implement feature X");
    const taskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayload),
    });

    // Register outbound task on A side (normally done by delegate_task tool)
    a.mamoru.registerOutboundTask(taskId, "sess-b");

    // B accepts
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");

    // B sends task_done
    const donePayload = createPayload("task_done", "Feature X implemented");
    sendMessage(db, {
      from_agent: "sess-b",
      to_agent: "sess-a",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(donePayload),
    });

    // B handles outbound status transition
    b.mamoru.handleOutbound("task_done", taskId);
    expect(b.mamoru.getStatus()).toBe("available");
    expect(b.mamoru.getActiveTask()).toBeNull();

    // B's DB status should be updated
    expect(getAgentBySession(db, "sess-b")!.status).toBe("available");

    // A polls — should receive task_done forwarded to LLM
    a.mamoru.pollOnce();
    const doneForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_done"),
    );
    expect(doneForwarded.length).toBe(1);
    expect(doneForwarded[0].content).toContain("Feature X implemented");

    // A's outbound task should be removed
    expect(a.mamoru.getOutboundTasks().has(taskId)).toBe(false);

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });

  test("A sends task_req to B (busy), B auto-rejects", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "A", "Planner");
    const b = createAgent(db, "sess-b", "B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // First task — B accepts and becomes busy
    const firstPayload = createPayload("task_req", "First task");
    const firstTaskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(firstPayload),
    });
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");

    // A sends another task_req while B is busy
    const secondPayload = createPayload("task_req", "Second task");
    const secondTaskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(secondPayload),
    });

    // B polls — should auto-reject the second task
    b.mamoru.pollOnce();

    const rejects = getMessagesByEvent(db, "sess-b", "task_reject");
    expect(rejects.length).toBe(1);
    expect(rejects[0].task_id).toBe(secondTaskId);
    expect(rejects[0].to_agent).toBe("sess-a");

    // B should still be busy with the first task
    expect(b.mamoru.getStatus()).toBe("busy");
    expect(b.mamoru.getActiveTask()!.taskId).toBe(firstTaskId);

    // A polls — should see task_reject forwarded to LLM
    a.mamoru.pollOnce();
    const rejectForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_reject"),
    );
    expect(rejectForwarded.length).toBe(1);

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });
});

// ── Task Clarification Flow ─────────────────────────────────────

describe("task clarification flow", () => {
  test("full flow: task_req -> task_ack -> task_clarify -> task_clarify_res -> task_done", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Requester", "Planner");
    const b = createAgent(db, "sess-b", "Worker", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // Step 1: A sends task_req to B
    const taskPayload = createPayload("task_req", "Build the login page");
    const taskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayload),
    });
    a.mamoru.registerOutboundTask(taskId, "sess-b");

    // Step 2: B polls — auto-acks
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");
    expect(b.mamoru.getActiveTask()!.taskId).toBe(taskId);

    // Verify task_ack was sent
    const acks = getMessagesByEvent(db, "sess-b", "task_ack");
    expect(acks.length).toBe(1);
    expect(acks[0].task_id).toBe(taskId);

    // Step 3: B sends task_clarify (simulating LLM deciding to clarify)
    const clarifyPayload = createPayload("task_clarify", "Should I use OAuth or email/password?");
    const clarifyMsgId = sendMessage(db, {
      from_agent: "sess-b",
      to_agent: "sess-a",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(clarifyPayload),
    });

    // Step 4: A polls — gets task_clarify forwarded to LLM
    a.mamoru.pollOnce();
    const clarifyForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_clarify"),
    );
    expect(clarifyForwarded.length).toBe(1);
    expect(clarifyForwarded[0].content).toContain("OAuth or email/password");

    // Step 5: A sends task_clarify_res
    const clarifyResPayload = createPayload("task_clarify_res", "Use OAuth with Google provider");
    const clarifyResMsgId = sendMessage(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: clarifyMsgId,
      payload: JSON.stringify(clarifyResPayload),
    });

    // Step 6: B polls — gets task_clarify_res forwarded to LLM
    b.mamoru.pollOnce();
    const clarifyResForwarded = b.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_clarify_res"),
    );
    expect(clarifyResForwarded.length).toBe(1);
    expect(clarifyResForwarded[0].content).toContain("OAuth with Google provider");

    // Step 7: B sends task_done
    const donePayload = createPayload("task_done", "Login page built with OAuth");
    sendMessage(db, {
      from_agent: "sess-b",
      to_agent: "sess-a",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: clarifyResMsgId,
      payload: JSON.stringify(donePayload),
    });
    b.mamoru.handleOutbound("task_done", taskId);

    // B should be available again
    expect(b.mamoru.getStatus()).toBe("available");
    expect(b.mamoru.getActiveTask()).toBeNull();

    // Step 8: A polls — gets task_done
    a.mamoru.pollOnce();
    const doneForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_done"),
    );
    expect(doneForwarded.length).toBe(1);
    expect(doneForwarded[0].content).toContain("Login page built with OAuth");

    // Verify all messages in the task share the same task_id
    const taskMessages = getMessagesByTaskId(db, taskId);
    expect(taskMessages.length).toBeGreaterThanOrEqual(4); // task_req, task_ack, task_clarify, task_clarify_res, task_done
    for (const msg of taskMessages) {
      expect(msg.task_id).toBe(taskId);
    }

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });
});

// ── Heartbeat/Liveness ──────────────────────────────────────────

describe("heartbeat/liveness", () => {
  test("A pings B, B auto-pongs", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Pinger");
    const b = createAgent(db, "sess-b", "Agent B", "Ponger");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A sends ping to B
    const pingPayload = createPayload("ping", "ping");
    sendMessage(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(pingPayload),
    });

    // B polls — should auto-reply with pong
    b.mamoru.pollOnce();

    // Verify pong message in DB
    const pongs = getMessagesByEvent(db, "sess-b", "pong");
    expect(pongs.length).toBe(1);
    expect(pongs[0].to_agent).toBe("sess-a");

    const pongPayload = parsePayload(pongs[0].payload);
    expect(pongPayload!.event).toBe("pong");
    expect(pongPayload!.content).toBe("pong");

    // Verify ping was not forwarded to B's LLM
    expect(b.pi.sentUserMessages.length).toBe(0);

    // B's heartbeat should be updated in DB
    const agentB = getAgentBySession(db, "sess-b");
    expect(agentB!.last_heartbeat).toBeGreaterThan(0);

    // A polls — receives the pong (silently consumed, no LLM forward)
    a.mamoru.pollOnce();
    // Pong is silently consumed — no new LLM messages for A
    const pongForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("pong"),
    );
    expect(pongForwarded.length).toBe(0);

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });

  test("bidirectional ping/pong between A and B", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Node 1");
    const b = createAgent(db, "sess-b", "Agent B", "Node 2");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A pings B
    sendMessage(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(createPayload("ping", "ping")),
    });

    // B pings A
    sendMessage(db, {
      from_agent: "sess-b",
      to_agent: "sess-a",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(createPayload("ping", "ping")),
    });

    // Both poll
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // Both should have sent pongs
    const pongsFromA = getMessagesByEvent(db, "sess-a", "pong");
    const pongsFromB = getMessagesByEvent(db, "sess-b", "pong");

    expect(pongsFromA.length).toBe(1);
    expect(pongsFromA[0].to_agent).toBe("sess-b");

    expect(pongsFromB.length).toBe(1);
    expect(pongsFromB[0].to_agent).toBe("sess-a");

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });
});

// ── Three-Agent Collaboration ───────────────────────────────────

describe("three-agent collaboration", () => {
  test("coordinator delegates to two workers, both report back", () => {
    const db = createSharedDb();
    const coord = createAgent(db, "sess-coord", "Coordinator", "Orchestrator");
    const workerA = createAgent(db, "sess-wa", "Worker A", "Frontend dev");
    const workerB = createAgent(db, "sess-wb", "Worker B", "Backend dev");

    coord.mamoru.start();
    workerA.mamoru.start();
    workerB.mamoru.start();

    // All discover each other
    coord.mamoru.pollOnce();
    workerA.mamoru.pollOnce();
    workerB.mamoru.pollOnce();

    // Coordinator sends task to Worker A
    const taskPayloadA = createPayload("task_req", "Build the UI");
    const taskIdA = sendTaskReq(db, {
      from_agent: "sess-coord",
      to_agent: "sess-wa",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayloadA),
    });
    coord.mamoru.registerOutboundTask(taskIdA, "sess-wa");

    // Coordinator sends task to Worker B
    const taskPayloadB = createPayload("task_req", "Build the API");
    const taskIdB = sendTaskReq(db, {
      from_agent: "sess-coord",
      to_agent: "sess-wb",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayloadB),
    });
    coord.mamoru.registerOutboundTask(taskIdB, "sess-wb");

    // Both workers poll and accept
    workerA.mamoru.pollOnce();
    workerB.mamoru.pollOnce();

    expect(workerA.mamoru.getStatus()).toBe("busy");
    expect(workerA.mamoru.getActiveTask()!.taskId).toBe(taskIdA);
    expect(workerB.mamoru.getStatus()).toBe("busy");
    expect(workerB.mamoru.getActiveTask()!.taskId).toBe(taskIdB);

    // Worker A completes
    sendMessage(db, {
      from_agent: "sess-wa",
      to_agent: "sess-coord",
      channel: CHANNEL,
      task_id: taskIdA,
      ref_message_id: taskIdA,
      payload: JSON.stringify(createPayload("task_done", "UI built")),
    });
    workerA.mamoru.handleOutbound("task_done", taskIdA);
    expect(workerA.mamoru.getStatus()).toBe("available");

    // Worker B completes
    sendMessage(db, {
      from_agent: "sess-wb",
      to_agent: "sess-coord",
      channel: CHANNEL,
      task_id: taskIdB,
      ref_message_id: taskIdB,
      payload: JSON.stringify(createPayload("task_done", "API built")),
    });
    workerB.mamoru.handleOutbound("task_done", taskIdB);
    expect(workerB.mamoru.getStatus()).toBe("available");

    // Coordinator polls — should receive both task_done messages
    coord.mamoru.pollOnce();

    const doneMessages = coord.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_done"),
    );
    expect(doneMessages.length).toBe(2);

    // Both outbound tasks should be cleared
    expect(coord.mamoru.getOutboundTasks().has(taskIdA)).toBe(false);
    expect(coord.mamoru.getOutboundTasks().has(taskIdB)).toBe(false);

    coord.mamoru.stop();
    workerA.mamoru.stop();
    workerB.mamoru.stop();
    db.close();
  });

  test("broadcast from one agent is seen by all others", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Role A");
    const b = createAgent(db, "sess-b", "Agent B", "Role B");
    const c = createAgent(db, "sess-c", "Agent C", "Role C");

    a.mamoru.start();
    b.mamoru.start();
    c.mamoru.start();

    // All discover each other
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();
    c.mamoru.pollOnce();

    // A sends a generic broadcast (no matching intent — will be forwarded to LLM)
    const broadcastPayload = createPayload("broadcast", "Deploy complete!", {
      intent: "deploy_notify",
    });
    sendMessage(db, {
      from_agent: "sess-a",
      to_agent: null,
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(broadcastPayload),
    });

    // B and C poll
    b.mamoru.pollOnce();
    c.mamoru.pollOnce();

    // Both should see the broadcast forwarded to LLM
    const bBroadcasts = b.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Deploy complete!"),
    );
    const cBroadcasts = c.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Deploy complete!"),
    );

    expect(bBroadcasts.length).toBe(1);
    expect(cBroadcasts.length).toBe(1);

    // A should NOT see its own broadcast
    a.mamoru.pollOnce();
    const aSelfBroadcasts = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Deploy complete!"),
    );
    expect(aSelfBroadcasts.length).toBe(0);

    a.mamoru.stop();
    b.mamoru.stop();
    c.mamoru.stop();
    db.close();
  });
});

// ── Task Cancel in Multi-Agent ──────────────────────────────────

describe("task cancel in multi-agent", () => {
  test("A cancels task on B, B becomes available again", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "A", "Planner");
    const b = createAgent(db, "sess-b", "B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A sends task_req to B
    const taskPayload = createPayload("task_req", "Write tests");
    const taskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayload),
    });
    a.mamoru.registerOutboundTask(taskId, "sess-b");

    // B accepts
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");

    // A sends task_cancel
    const cancelPayload = createPayload("task_cancel", "Requirements changed, cancel this");
    sendMessage(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(cancelPayload),
    });

    // B polls — should auto-ack the cancel
    b.mamoru.pollOnce();

    expect(b.mamoru.getStatus()).toBe("available");
    expect(b.mamoru.getActiveTask()).toBeNull();
    expect(b.ctx.aborted).toBe(true);

    // Verify task_cancel_ack was sent
    const cancelAcks = getMessagesByEvent(db, "sess-b", "task_cancel_ack");
    expect(cancelAcks.length).toBe(1);
    expect(cancelAcks[0].task_id).toBe(taskId);
    expect(cancelAcks[0].to_agent).toBe("sess-a");

    // A polls — should see task_cancel_ack (removes outbound task)
    a.mamoru.pollOnce();
    expect(a.mamoru.getOutboundTasks().has(taskId)).toBe(false);

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });
});

// ── Task Failure Flow ───────────────────────────────────────────

describe("task failure flow", () => {
  test("B fails task, A receives task_fail, B becomes available", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "A", "Planner");
    const b = createAgent(db, "sess-b", "B", "Developer");

    a.mamoru.start();
    b.mamoru.start();

    // Discover
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();

    // A sends task_req
    const taskPayload = createPayload("task_req", "Deploy to production");
    const taskId = sendTaskReq(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      payload: JSON.stringify(taskPayload),
    });
    a.mamoru.registerOutboundTask(taskId, "sess-b");

    // B accepts
    b.mamoru.pollOnce();
    expect(b.mamoru.getStatus()).toBe("busy");

    // B reports failure
    const failPayload = createPayload("task_fail", "Server unreachable");
    sendMessage(db, {
      from_agent: "sess-b",
      to_agent: "sess-a",
      channel: CHANNEL,
      task_id: taskId,
      ref_message_id: taskId,
      payload: JSON.stringify(failPayload),
    });
    b.mamoru.handleOutbound("task_fail", taskId);

    expect(b.mamoru.getStatus()).toBe("available");
    expect(b.mamoru.getActiveTask()).toBeNull();

    // A polls — should receive task_fail
    a.mamoru.pollOnce();
    const failForwarded = a.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("task_fail"),
    );
    expect(failForwarded.length).toBe(1);
    expect(failForwarded[0].content).toContain("Server unreachable");
    expect(a.mamoru.getOutboundTasks().has(taskId)).toBe(false);

    a.mamoru.stop();
    b.mamoru.stop();
    db.close();
  });
});

// ── Message Isolation ───────────────────────────────────────────

describe("message isolation", () => {
  test("directed messages are only seen by the target agent", () => {
    const db = createSharedDb();
    const a = createAgent(db, "sess-a", "Agent A", "Role A");
    const b = createAgent(db, "sess-b", "Agent B", "Role B");
    const c = createAgent(db, "sess-c", "Agent C", "Role C");

    a.mamoru.start();
    b.mamoru.start();
    c.mamoru.start();

    // All discover each other
    a.mamoru.pollOnce();
    b.mamoru.pollOnce();
    c.mamoru.pollOnce();

    // A sends info_only directed to B only
    const infoPayload = createPayload("info_only", "Secret info for B only");
    sendMessage(db, {
      from_agent: "sess-a",
      to_agent: "sess-b",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: JSON.stringify(infoPayload),
    });

    // All poll
    b.mamoru.pollOnce();
    c.mamoru.pollOnce();

    // B should see the message
    const bInfoMsgs = b.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Secret info for B only"),
    );
    expect(bInfoMsgs.length).toBe(1);

    // C should NOT see the message (it's directed to B)
    const cInfoMsgs = c.pi.sentUserMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Secret info for B only"),
    );
    expect(cInfoMsgs.length).toBe(0);

    a.mamoru.stop();
    b.mamoru.stop();
    c.mamoru.stop();
    db.close();
  });
});
