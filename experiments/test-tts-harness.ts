#!/usr/bin/env bun
/**
 * Test script for the TTS harness.
 *
 * Creates a temporary channel DB, inserts fake messages with various events,
 * and runs the TTS harness against it to verify end-to-end behavior.
 *
 * Usage:
 *   bun run experiments/test-tts-harness.ts
 *
 * What it does:
 *   1. Creates a temp channel "tts-test-<timestamp>"
 *   2. Starts the TTS harness pointing at it
 *   3. Inserts test messages (task_req, task_ack, task_update, task_done, task_fail)
 *   4. Waits for the harness to process them
 *   5. Cleans up
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

// ── Setup ───────────────────────────────────────────────────────

const CHANNEL = `tts-test-${Date.now()}`;
const BASE_DIR = join(homedir(), ".pi", "pi-teammate");
const CHANNEL_DIR = join(BASE_DIR, CHANNEL);
const DB_PATH = join(CHANNEL_DIR, "team.db");

// Create temp persona dirs with voiceId
const TEMP_DIR = join(CHANNEL_DIR, "_test-personas");
const DEV_PERSONA_DIR = join(TEMP_DIR, "developer");
const TESTER_PERSONA_DIR = join(TEMP_DIR, "tester");

function setupPersonas(): void {
  mkdirSync(DEV_PERSONA_DIR, { recursive: true });
  mkdirSync(TESTER_PERSONA_DIR, { recursive: true });

  writeFileSync(join(DEV_PERSONA_DIR, "persona.yaml"), [
    'name: "Developer"',
    'voice: "Rachel"',
    'voiceId: "21m00Tcm4TlvDq8ikWAM"',
    'description: "Fullstack developer"',
  ].join("\n"));

  writeFileSync(join(TESTER_PERSONA_DIR, "persona.yaml"), [
    'name: "Tester"',
    'voice: "Joseph"',
    'voiceId: "oyxaSt75JW8l04MCJaSo"',
    'description: "QA engineer"',
  ].join("\n"));
}

// ── DB setup using bun:sqlite directly ──────────────────────────

function setupDb(): Database {
  mkdirSync(CHANNEL_DIR, { recursive: true });
  const db = new Database(DB_PATH);

  // Init schema (inline — avoids importing from extensions which use better-sqlite3 types)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      description TEXT,
      provider TEXT,
      model TEXT,
      cwd TEXT,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','busy','inactive')),
      last_heartbeat INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      channel TEXT NOT NULL,
      task_id INTEGER,
      ref_message_id INTEGER,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_agent) REFERENCES agents(session_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_cursors (
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, channel)
    )
  `);

  // Register two agents
  db.prepare(`
    INSERT OR REPLACE INTO agents (session_id, agent_name, description, status)
    VALUES (?, ?, ?, 'available')
  `).run("dev-session", "Developer", "Fullstack developer");

  db.prepare(`
    INSERT OR REPLACE INTO agents (session_id, agent_name, description, status)
    VALUES (?, ?, ?, 'available')
  `).run("tester-session", "Tester", "QA engineer");

  return db;
}

// ── Message insertion helpers ───────────────────────────────────

function insertMessage(
  db: Database,
  from: string,
  to: string | null,
  event: string,
  content: string,
  taskId: number | null,
): number {
  const payload = JSON.stringify({
    event,
    intent: null,
    need_reply: event === "task_req",
    content,
    detail: null,
  });
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, channel, task_id, ref_message_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(from, to, CHANNEL, taskId, taskId, payload, now);
  return Number(result.lastInsertRowid);
}

function insertTaskReq(db: Database, from: string, to: string, content: string): number {
  const payload = JSON.stringify({
    event: "task_req",
    intent: null,
    need_reply: true,
    content,
    detail: null,
  });
  const now = Date.now();
  // For task_req, first insert with task_id=NULL, then update to self-reference
  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, channel, task_id, ref_message_id, payload, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?)
  `).run(from, to, CHANNEL, payload, now);
  const msgId = Number(result.lastInsertRowid);
  db.prepare("UPDATE messages SET task_id = ?, ref_message_id = NULL WHERE message_id = ?").run(msgId, msgId);
  return msgId;
}

// ── Test messages ───────────────────────────────────────────────

function insertTestMessages(db: Database): void {
  // Insert task_req first to get a task_id
  const taskId = insertTaskReq(db, "dev-session", "tester-session", "Please review the login page");
  console.log(`📨 [0s] Inserted task_req #${taskId}: "Please review the login page"`);

  const scheduled = [
    { from: "tester-session", to: "dev-session", event: "task_ack", content: "On it, reviewing now", delayMs: 2000 },
    { from: "tester-session", to: "dev-session", event: "task_update", content: "Found a minor styling issue", delayMs: 4000 },
    { from: "tester-session", to: "dev-session", event: "task_done", content: "Review complete, all tests pass", delayMs: 6000 },
    { from: "dev-session", to: "tester-session", event: "task_fail", content: "Build failed after merge conflict", delayMs: 8000 },
  ];

  for (const msg of scheduled) {
    setTimeout(() => {
      const msgId = insertMessage(db, msg.from, msg.to, msg.event, msg.content, taskId);
      console.log(`📨 [${msg.delayMs / 1000}s] Inserted ${msg.event} #${msgId}: "${msg.content}"`);
    }, msg.delayMs);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🧪 TTS Harness Test");
  console.log("═".repeat(60));

  // Setup
  console.log(`\n📁 Channel: ${CHANNEL}`);
  setupPersonas();
  const db = setupDb();

  // Start the harness
  console.log("\n🚀 Starting TTS harness...\n");
  const personaDirs = `${DEV_PERSONA_DIR},${TESTER_PERSONA_DIR}`;
  const harness: ChildProcess = spawn(
    "bun",
    [
      "run",
      join(import.meta.dir, "tts-harness.ts"),
      CHANNEL,
      "--poll-ms=500",
      `--persona-dirs=${personaDirs}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(import.meta.dir, ".."),
    },
  );

  harness.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`  [harness] ${line}`);
    }
  });

  harness.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`  [harness:err] ${line}`);
    }
  });

  // Wait for harness to initialize
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Insert test messages (with staggered timing)
  console.log("\n📝 Inserting test messages...\n");
  insertTestMessages(db);

  // Wait for all messages to be inserted and processed
  const totalDuration = 8000 + 5000; // last message at 8s + 5s buffer for TTS
  console.log(`\n⏳ Waiting ${totalDuration / 1000}s for all messages to be spoken...\n`);
  await new Promise(resolve => setTimeout(resolve, totalDuration));

  // Cleanup
  console.log("\n🧹 Cleaning up...");
  harness.kill("SIGINT");
  await new Promise(resolve => setTimeout(resolve, 500));
  db.close();

  try {
    rmSync(CHANNEL_DIR, { recursive: true, force: true });
    console.log(`   Removed ${CHANNEL_DIR}`);
  } catch {}

  console.log("\n✅ Test complete!\n");
}

main().catch((err) => {
  console.error(`\n❌ Test failed: ${err.message}`);
  process.exit(1);
});
