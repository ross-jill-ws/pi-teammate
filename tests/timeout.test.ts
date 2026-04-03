import { describe, test, expect } from "bun:test";
import { TimeoutManager } from "../extensions/timeout.ts";
import { createTestDb } from "./helpers/mock-pi.ts";
import { registerAgent, getAgentBySession } from "../extensions/db.ts";
import type { MamoruConfig, OutboundTask, MessageRow } from "../extensions/types.ts";

const testConfig: MamoruConfig = { pollIntervalMs: 50, taskTimeoutMinutes: 0.001, pingTimeoutSeconds: 0.05 };
// taskTimeoutMinutes: 0.001 = 60ms, pingTimeoutSeconds: 0.05 = 50ms
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup() {
  const db = createTestDb();
  const senderSession = `sender-${Date.now()}-${Math.random()}`;
  const workerSession = `worker-${Date.now()}-${Math.random()}`;
  const channel = "test-channel";

  registerAgent(db, { session_id: senderSession, agent_name: "sender", description: "sender agent", provider: null, model: null, cwd: null });
  registerAgent(db, { session_id: workerSession, agent_name: "worker", description: "worker agent", provider: null, model: null, cwd: null });

  const outboundTasks = new Map<number, OutboundTask>();
  const timeoutCalls: Array<{ taskId: number; workerSessionId: string }> = [];

  const tm = new TimeoutManager({
    config: testConfig,
    outboundTasks,
    db,
    sessionId: senderSession,
    channel,
    onTimeout: (taskId, workerSessionId) => {
      timeoutCalls.push({ taskId, workerSessionId });
    },
  });

  return { db, senderSession, workerSession, channel, outboundTasks, timeoutCalls, tm };
}

function getMessagesByEvent(db: any, event: string): MessageRow[] {
  const rows = db.prepare("SELECT * FROM messages ORDER BY message_id ASC").all() as MessageRow[];
  return rows.filter((r: MessageRow) => {
    try {
      const p = JSON.parse(r.payload);
      return p.event === event;
    } catch { return false; }
  });
}

describe("TimeoutManager", () => {
  test("startTracking adds task to outboundTasks", () => {
    const { tm, outboundTasks, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      expect(outboundTasks.size).toBe(1);
      expect(outboundTasks.has(1)).toBe(true);
      const task = outboundTasks.get(1)!;
      expect(task.taskId).toBe(1);
      expect(task.workerSessionId).toBe(workerSession);
      expect(task.timeoutTimer).not.toBeNull();
    } finally {
      tm.clearAll();
    }
  });

  test("stopTracking removes task and clears timer", () => {
    const { tm, outboundTasks, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      expect(outboundTasks.size).toBe(1);
      tm.stopTracking(1);
      expect(outboundTasks.size).toBe(0);
    } finally {
      tm.clearAll();
    }
  });

  test("clearAll stops all tracking", () => {
    const { tm, outboundTasks, workerSession } = setup();
    tm.startTracking(1, workerSession);
    tm.startTracking(2, workerSession);
    expect(outboundTasks.size).toBe(2);
    tm.clearAll();
    expect(outboundTasks.size).toBe(0);
  });

  test("isTracking returns correct state", () => {
    const { tm, workerSession } = setup();
    try {
      expect(tm.isTracking(1)).toBe(false);
      tm.startTracking(1, workerSession);
      expect(tm.isTracking(1)).toBe(true);
      tm.stopTracking(1);
      expect(tm.isTracking(1)).toBe(false);
    } finally {
      tm.clearAll();
    }
  });

  test("timeout fires and sends task_cancel", async () => {
    const { tm, db, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      // Wait for primary timeout (60ms) + buffer
      await wait(100);
      const cancelMsgs = getMessagesByEvent(db, "task_cancel");
      expect(cancelMsgs.length).toBe(1);
      const payload = JSON.parse(cancelMsgs[0].payload);
      expect(payload.event).toBe("task_cancel");
      expect(payload.intent).toBe("task_timeout");
      expect(payload.need_reply).toBe(true);
    } finally {
      tm.clearAll();
    }
  });

  test("resetTimer prevents timeout", async () => {
    const { tm, db, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      // Wait 30ms (halfway through 60ms timeout), then reset
      await wait(30);
      tm.resetTimer(1);
      // Wait another 50ms — would have timed out at 60ms without reset
      await wait(50);
      const cancelMsgs = getMessagesByEvent(db, "task_cancel");
      expect(cancelMsgs.length).toBe(0);
    } finally {
      tm.clearAll();
    }
  });

  test("marks worker inactive after secondary timeout", async () => {
    const { tm, db, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      // Wait for primary timeout (60ms) + secondary timeout (50ms) + buffer
      await wait(150);
      const agent = getAgentBySession(db, workerSession);
      expect(agent).not.toBeNull();
      expect(agent!.status).toBe("inactive");
    } finally {
      tm.clearAll();
    }
  });

  test("calls onTimeout callback", async () => {
    const { tm, timeoutCalls, workerSession } = setup();
    try {
      tm.startTracking(1, workerSession);
      // Wait for primary (60ms) + secondary (50ms) + buffer
      await wait(150);
      expect(timeoutCalls.length).toBe(1);
      expect(timeoutCalls[0].taskId).toBe(1);
      expect(timeoutCalls[0].workerSessionId).toBe(workerSession);
    } finally {
      tm.clearAll();
    }
  });

  test("stopTracking during secondary timeout prevents inactive marking", async () => {
    const { tm, db, workerSession, timeoutCalls } = setup();
    try {
      tm.startTracking(1, workerSession);
      // Wait for primary timeout to fire (60ms + small buffer)
      await wait(80);
      // Verify task_cancel was sent (primary fired)
      const cancelMsgs = getMessagesByEvent(db, "task_cancel");
      expect(cancelMsgs.length).toBe(1);
      // Now stop tracking before secondary fires (secondary is 50ms after primary)
      tm.stopTracking(1);
      // Wait for secondary timer to pass
      await wait(80);
      // Worker should still be available (not marked inactive)
      const agent = getAgentBySession(db, workerSession);
      expect(agent).not.toBeNull();
      expect(agent!.status).toBe("available");
      // onTimeout should NOT have been called
      expect(timeoutCalls.length).toBe(0);
    } finally {
      tm.clearAll();
    }
  });
});
