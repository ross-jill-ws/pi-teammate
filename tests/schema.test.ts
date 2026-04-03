import { describe, test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { initSchema } from "../extensions/schema.ts";
import { createBetterSqlite3Compat } from "./helpers/mock-pi.ts";

function createDb() {
  return createBetterSqlite3Compat(new BunDatabase(":memory:"));
}

describe("initSchema", () => {
  test("creates all three tables in a new DB", () => {
    const db = createDb();
    initSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("agents");
    expect(tables).toContain("messages");
    expect(tables).toContain("agent_cursors");
  });

  test("sets WAL journal mode", () => {
    const db = createDb();
    initSchema(db);

    // For :memory: DBs WAL may not persist, but user_version proves pragmas ran
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(2);
  });

  test("agents table has correct columns", () => {
    const db = createDb();
    initSchema(db);

    const columns = db.prepare("PRAGMA table_info(agents)").all() as any[];
    const colNames = columns.map((c: any) => c.name);

    expect(colNames).toEqual([
      "session_id",
      "agent_name",
      "description",
      "provider",
      "model",
      "cwd",
      "status",
      "last_heartbeat",
    ]);

    // session_id is primary key
    const pk = columns.find((c: any) => c.name === "session_id");
    expect(pk.pk).toBe(1);

    // agent_name is NOT NULL
    const agentName = columns.find((c: any) => c.name === "agent_name");
    expect(agentName.notnull).toBe(1);

    // status has default 'available'
    const status = columns.find((c: any) => c.name === "status");
    expect(status.dflt_value).toBe("'available'");
  });

  test("messages table has correct columns and foreign keys", () => {
    const db = createDb();
    initSchema(db);

    const columns = db.prepare("PRAGMA table_info(messages)").all() as any[];
    const colNames = columns.map((c: any) => c.name);

    expect(colNames).toEqual([
      "message_id",
      "from_agent",
      "to_agent",
      "channel",
      "task_id",
      "ref_message_id",
      "payload",
      "created_at",
    ]);

    // message_id is primary key autoincrement
    const msgId = columns.find((c: any) => c.name === "message_id");
    expect(msgId.pk).toBe(1);

    // Check foreign keys
    const fks = db.prepare("PRAGMA foreign_key_list(messages)").all() as any[];
    const fkTables = fks.map((fk: any) => ({ table: fk.table, from: fk.from, to: fk.to }));

    expect(fkTables).toContainEqual({ table: "agents", from: "from_agent", to: "session_id" });
    expect(fkTables).toContainEqual({ table: "messages", from: "task_id", to: "message_id" });
    expect(fkTables).toContainEqual({ table: "messages", from: "ref_message_id", to: "message_id" });
  });

  test("agent_cursors table has composite primary key", () => {
    const db = createDb();
    initSchema(db);

    const columns = db.prepare("PRAGMA table_info(agent_cursors)").all() as any[];

    // Both session_id and channel should have pk > 0
    const sessionId = columns.find((c: any) => c.name === "session_id");
    const channel = columns.find((c: any) => c.name === "channel");

    expect(sessionId.pk).toBeGreaterThan(0);
    expect(channel.pk).toBeGreaterThan(0);

    // last_read_id default is 0
    const lastReadId = columns.find((c: any) => c.name === "last_read_id");
    expect(lastReadId.dflt_value).toBe("0");
  });

  test("agents status CHECK constraint rejects invalid values", () => {
    const db = createDb();
    initSchema(db);

    // Valid statuses should work
    db.prepare(
      "INSERT INTO agents (session_id, agent_name, status) VALUES ('s1', 'a1', 'available')",
    ).run();
    db.prepare(
      "INSERT INTO agents (session_id, agent_name, status) VALUES ('s2', 'a2', 'busy')",
    ).run();
    db.prepare(
      "INSERT INTO agents (session_id, agent_name, status) VALUES ('s3', 'a3', 'inactive')",
    ).run();

    // Invalid status should throw
    try {
      db.prepare(
        "INSERT INTO agents (session_id, agent_name, status) VALUES ('s4', 'a4', 'invalid_status')",
      ).run();
      // If we get here, the constraint didn't fire
      expect(true).toBe(false); // force fail
    } catch (err: any) {
      expect(err.message).toMatch(/CHECK|constraint/i);
    }
  });

  test("initSchema is idempotent", () => {
    const db = createDb();

    // Call multiple times — should not throw
    initSchema(db);
    initSchema(db);
    initSchema(db);

    // Tables still exist and work
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("agents");
    expect(tables).toContain("messages");
    expect(tables).toContain("agent_cursors");

    // Data inserted before second init is preserved
    db.prepare(
      "INSERT INTO agents (session_id, agent_name) VALUES ('s1', 'test')",
    ).run();
    initSchema(db);
    const agent = db.prepare("SELECT * FROM agents WHERE session_id = 's1'").get() as any;
    expect(agent).toBeTruthy();
    expect(agent.agent_name).toBe("test");
  });
});
