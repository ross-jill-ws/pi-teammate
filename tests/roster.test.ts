import { describe, test, expect } from "bun:test";
import { Roster } from "../extensions/roster.ts";
import { createTestDb } from "./helpers/mock-pi.ts";
import type { RosterEntry } from "../extensions/types.ts";

function makeEntry(overrides: Partial<RosterEntry> & { session_id: string }): RosterEntry {
  return {
    agent_name: "Agent",
    description: "A test agent",
    status: "available",
    last_heartbeat: Date.now(),
    ...overrides,
  };
}

function insertAgent(db: any, agent: { session_id: string; agent_name: string; description?: string; status?: string; last_heartbeat?: number }) {
  db.prepare(
    "INSERT INTO agents (session_id, agent_name, description, status, last_heartbeat) VALUES (@session_id, @agent_name, @description, @status, @last_heartbeat)",
  ).run({
    session_id: agent.session_id,
    agent_name: agent.agent_name,
    description: agent.description ?? null,
    status: agent.status ?? "available",
    last_heartbeat: agent.last_heartbeat ?? Date.now(),
  });
}

describe("Roster", () => {
  describe("initFromDb", () => {
    test("populates roster from agents table", () => {
      const db = createTestDb();
      const roster = new Roster();

      insertAgent(db, { session_id: "s1", agent_name: "Alice", description: "Frontend dev" });
      insertAgent(db, { session_id: "s2", agent_name: "Bob", description: "Backend dev" });

      roster.initFromDb(db, "self-session");

      expect(roster.getAll()).toHaveLength(2);
      expect(roster.get("s1")?.agent_name).toBe("Alice");
      expect(roster.get("s2")?.agent_name).toBe("Bob");
      db.close();
    });

    test("excludes self from roster", () => {
      const db = createTestDb();
      const roster = new Roster();

      insertAgent(db, { session_id: "self-id", agent_name: "Me" });
      insertAgent(db, { session_id: "other-id", agent_name: "Other" });

      roster.initFromDb(db, "self-id");

      expect(roster.getAll()).toHaveLength(1);
      expect(roster.get("self-id")).toBeUndefined();
      expect(roster.get("other-id")?.agent_name).toBe("Other");
      db.close();
    });

    test("excludes inactive agents from roster", () => {
      const db = createTestDb();
      const roster = new Roster();

      insertAgent(db, { session_id: "active-id", agent_name: "Active" });
      insertAgent(db, { session_id: "inactive-id", agent_name: "Inactive", status: "inactive" });

      roster.initFromDb(db, "self-id");

      expect(roster.getAll()).toHaveLength(1);
      expect(roster.get("active-id")?.agent_name).toBe("Active");
      expect(roster.get("inactive-id")).toBeUndefined();
      db.close();
    });
  });

  describe("update", () => {
    test("adds a new entry", () => {
      const roster = new Roster();
      const entry = makeEntry({ session_id: "s1", agent_name: "Alice" });

      roster.update(entry);

      expect(roster.get("s1")).toEqual(entry);
      expect(roster.getAll()).toHaveLength(1);
    });

    test("overwrites existing entry for same session_id", () => {
      const roster = new Roster();
      const entry1 = makeEntry({ session_id: "s1", agent_name: "Alice", description: "v1" });
      const entry2 = makeEntry({ session_id: "s1", agent_name: "Alice-Updated", description: "v2" });

      roster.update(entry1);
      roster.update(entry2);

      expect(roster.getAll()).toHaveLength(1);
      expect(roster.get("s1")?.agent_name).toBe("Alice-Updated");
      expect(roster.get("s1")?.description).toBe("v2");
    });
  });

  describe("remove", () => {
    test("deletes entry by session_id", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "Alice" }));
      roster.update(makeEntry({ session_id: "s2", agent_name: "Bob" }));

      roster.remove("s1");

      expect(roster.get("s1")).toBeUndefined();
      expect(roster.getAll()).toHaveLength(1);
      expect(roster.get("s2")?.agent_name).toBe("Bob");
    });
  });

  describe("markInactive", () => {
    test("sets status to inactive", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", status: "available" }));

      roster.markInactive("s1");

      expect(roster.get("s1")?.status).toBe("inactive");
    });
  });

  describe("getAll", () => {
    test("returns all entries", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "Alice" }));
      roster.update(makeEntry({ session_id: "s2", agent_name: "Bob" }));
      roster.update(makeEntry({ session_id: "s3", agent_name: "Carol" }));

      const all = roster.getAll();

      expect(all).toHaveLength(3);
      const names = all.map((e) => e.agent_name).sort();
      expect(names).toEqual(["Alice", "Bob", "Carol"]);
    });
  });

  describe("getAvailable", () => {
    test("returns only available entries", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "Alice", status: "available" }));
      roster.update(makeEntry({ session_id: "s2", agent_name: "Bob", status: "busy" }));
      roster.update(makeEntry({ session_id: "s3", agent_name: "Carol", status: "inactive" }));
      roster.update(makeEntry({ session_id: "s4", agent_name: "Dave", status: "available" }));

      const available = roster.getAvailable();

      expect(available).toHaveLength(2);
      const names = available.map((e) => e.agent_name).sort();
      expect(names).toEqual(["Alice", "Dave"]);
    });
  });

  describe("buildToolDescription", () => {
    test("lists all teammates with name, session_id, status, description", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "abc123", agent_name: "Alice", status: "available", description: "Frontend dev" }));
      roster.update(makeEntry({ session_id: "def456", agent_name: "Bob", status: "available", description: "Backend dev" }));

      const desc = roster.buildToolDescription("self-session");

      expect(desc).toContain("Send a message to a teammate or broadcast to the team.");
      expect(desc).toContain('"Alice" (session: abc123) — available — Frontend dev');
      expect(desc).toContain('"Bob" (session: def456) — available — Backend dev');
      expect(desc).toContain("Pick an 'available' agent whose description matches the request.");
      expect(desc).toContain("task_req");
    });

    test("excludes self from listing", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "self-id", agent_name: "Me", description: "Self" }));
      roster.update(makeEntry({ session_id: "other-id", agent_name: "Other", description: "Teammate" }));

      const desc = roster.buildToolDescription("self-id");

      expect(desc).not.toContain("Me");
      expect(desc).not.toContain("self-id");
      expect(desc).toContain('"Other" (session: other-id)');
    });

    test("shows 'No teammates' when roster is empty", () => {
      const roster = new Roster();

      const desc = roster.buildToolDescription("self-session");

      expect(desc).toContain("No teammates are currently online.");
    });

    test("marks busy agents as busy", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "BusyBot", status: "busy", description: "Overloaded" }));

      const desc = roster.buildToolDescription("self-session");

      expect(desc).toContain('"BusyBot" (session: s1) — busy — Overloaded');
    });

    test("marks inactive agents as inactive", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "GhostBot", status: "inactive", description: "Gone" }));

      const desc = roster.buildToolDescription("self-session");

      expect(desc).toContain('"GhostBot" (session: s1) — inactive — Gone');
    });

    test("updates description when roster changes", () => {
      const roster = new Roster();
      roster.update(makeEntry({ session_id: "s1", agent_name: "Alice", status: "available", description: "Frontend" }));

      const desc1 = roster.buildToolDescription("self-session");
      expect(desc1).toContain('"Alice"');
      expect(desc1).not.toContain('"Bob"');

      roster.update(makeEntry({ session_id: "s2", agent_name: "Bob", status: "available", description: "Backend" }));

      const desc2 = roster.buildToolDescription("self-session");
      expect(desc2).toContain('"Alice"');
      expect(desc2).toContain('"Bob"');

      roster.remove("s1");

      const desc3 = roster.buildToolDescription("self-session");
      expect(desc3).not.toContain('"Alice"');
      expect(desc3).toContain('"Bob"');
    });
  });
});
