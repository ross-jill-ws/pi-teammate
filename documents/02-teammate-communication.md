# Communication & Messaging

This document explains how `pi-teammate` agents communicate — the shared SQLite message bus, the message payload schema, the task lifecycle events, and the MAMORU guardian process that keeps everything running smoothly.

---

## The Message Bus: SQLite

All teammate communication flows through a **shared SQLite database** — one file per channel, running in WAL mode. There is no central broker, no server to configure, and no ports to open. SQLite is just a file on disk.

### Why SQLite?

- **No infrastructure** — no message broker to install or maintain.
- **Concurrent readers** — WAL mode allows multiple agents to read simultaneously without blocking.
- **Cursor-based delivery** — the sender writes one row; each recipient tracks its own read position. No fan-out logic needed.
- **Sub-millisecond reads** — the poll query is an index seek on an integer primary key.

### Directory Layout

All team data is stored under `~/.pi/pi-teammate/`:

```
~/.pi/pi-teammate/
└── <channel>/                          # e.g. "forex-rt"
    ├── team.db                         # shared SQLite database (WAL mode)
    ├── <teammate_A_session_id>/        # detail files produced by teammate A
    │   ├── review-pr123.md
    │   └── test-results.json
    └── <teammate_B_session_id>/        # detail files produced by teammate B
        └── refactor-spec.md
```

- Each channel name maps to exactly **one directory** with **one `team.db`** file.
- Each teammate gets a dedicated subdirectory (keyed by session ID) for storing **detail files** — large content like task specs, review results, or test output referenced by the `detail` field in message payloads.
- `--team-new` or `/team-create` deletes the entire `<channel>/` directory and creates a fresh database.

---

## Database Schema

The database has three tables:

### `agents`

Tracks every agent that has joined the channel.

```sql
CREATE TABLE agents (
  session_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  description TEXT,              -- from persona.yaml, broadcast to teammates
  provider TEXT,                 -- LLM provider (e.g., "anthropic")
  model TEXT,                    -- model identifier (e.g., "claude-opus-4-6")
  cwd TEXT,
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'busy', 'inactive')),
  last_heartbeat INTEGER         -- epoch ms
);
```

| Status | Meaning |
|--------|---------|
| `available` | Ready to accept tasks |
| `busy` | Currently working on a task |
| `inactive` | No heartbeat detected — agent may have crashed or disconnected |

### `messages`

The single message table. Every message — broadcasts, DMs, task requests, task results — is one row.

```sql
CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,       -- session_id of sender
  to_agent TEXT,                  -- session_id for DM, NULL for broadcast
  channel TEXT NOT NULL,          -- team/group identifier
  task_id INTEGER,               -- the originating task_req's message_id
  ref_message_id INTEGER,        -- the specific message this replies to
  payload TEXT NOT NULL,          -- JSON (see payload schema below)
  created_at INTEGER NOT NULL,   -- epoch ms
  FOREIGN KEY (from_agent) REFERENCES agents(session_id),
  FOREIGN KEY (task_id) REFERENCES messages(message_id),
  FOREIGN KEY (ref_message_id) REFERENCES messages(message_id)
);
```

**DM vs Broadcast:**
- **Direct Message:** `to_agent` is set to a specific `session_id`.
- **Broadcast:** `to_agent` is `NULL` — all agents on the channel receive it.

In both cases, the sender writes exactly one row. Each recipient detects new messages by polling against their own cursor.

### `agent_cursors`

Reader-side cursor tracking. Each agent tracks its own read position independently.

```sql
CREATE TABLE agent_cursors (
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_read_id INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, channel),
  FOREIGN KEY (session_id) REFERENCES agents(session_id)
);
```

When a new agent joins, `last_read_id` is set to `MAX(message_id)` — skipping all historical messages so the new member doesn't replay old conversations.

---

## Message Payload Schema

The `payload` column stores a JSON string:

```jsonc
{
  "event": "task_req",          // event type (see below)
  "intent": "code_review",      // freeform routing hint for MAMORU
  "need_reply": true,           // whether the recipient should respond
  "content": "Short summary",   // max ~20 words, enforced by the extension
  "detail": "/abs/path/to/file" // optional; file path for large content
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event` | string (enum) | The message event type. |
| `intent` | string or null | Freeform hint for MAMORU routing (e.g., `agent_join`, `code_review`). Not an enum — extensible without schema changes. |
| `need_reply` | boolean | `true` = recipient must respond. `false` = informational only. |
| `content` | string | Brief message body. Keep it short — full details go in the `detail` file. |
| `detail` | string or null | Absolute file path for large content. Required for `task_req`. Also used for `task_done`/`task_fail` to include results. |

---

## Event Types

Events model the natural patterns of collaboration. They are grouped by purpose.

### Informational (no reply expected)

| Event | Description |
|-------|-------------|
| `broadcast` | Announcement to all agents on the channel. |
| `info_only` | Informational DM to a specific agent. |

### Liveness

| Event | Description |
|-------|-------------|
| `ping` | Liveness check. If no `pong` within 20 seconds, mark recipient as `inactive`. |
| `pong` | Response to `ping`. Handled automatically by MAMORU. |

### Task Lifecycle

| Event | Direction | Description |
|-------|-----------|-------------|
| `task_req` | requester → worker | Request an agent to perform a task. |
| `task_ack` | worker → requester | Acknowledge receipt; work is starting. |
| `task_reject` | worker → requester | Decline the task (busy, wrong agent, out of scope). |
| `task_clarify` | worker → requester | Ask the requester for more information mid-task. |
| `task_clarify_res` | requester → worker | Provide the requested clarification. |
| `task_update` | worker → requester | Progress update while work is in-flight. |
| `task_done` | worker → requester | Task completed. Result in `content` and/or `detail`. |
| `task_fail` | worker → requester | Task failed. Reason in `content`. |
| `task_cancel` | requester → worker | Request cancellation of an in-flight task. |
| `task_cancel_ack` | worker → requester | Acknowledge cancellation. |

### Common Intents

| Event | Intent | Description |
|-------|--------|-------------|
| `broadcast` | `agent_join` | Agent introducing itself to the team. |
| `broadcast` | `agent_leave` | Agent announcing it's going offline. |
| `broadcast` | `agent_status_change` | Agent status changed (e.g., busy → available). |
| `task_req` | _(domain-specific)_ | Hints at the kind of work, e.g., `code_review`, `write_tests`. |
| `task_cancel` | `task_timeout` | Cancellation due to timeout. |

---

## Task Correlation

Two fields keep task conversations organized:

- **`task_id`** — the originating `task_req`'s `message_id`. **Same for ALL messages in a task conversation.** This is the correlation key that groups the entire task lifecycle together.
- **`ref_message_id`** — which specific message this is directly responding to. This is the reply chain for conversational threading.

For `task_req` itself: `task_id` = its own `message_id` (self-referencing), `ref_message_id` = `NULL`.
For non-task messages (`broadcast`, `info_only`, `ping`, `pong`): both are `NULL`.

### Example

```
task_req       (message_id=42, task_id=42,  ref_message_id=NULL)
  ← task_ack         (message_id=43, task_id=42,  ref_message_id=42)
  ← task_clarify     (message_id=44, task_id=42,  ref_message_id=42)
  → task_clarify_res (message_id=45, task_id=42,  ref_message_id=44)  ← replies to the clarify
  ← task_update      (message_id=46, task_id=42,  ref_message_id=42)
  ← task_done        (message_id=47, task_id=42,  ref_message_id=42)
```

---

## Example Flows

### Simple Task Request

```
Agent A (Planner)                         Agent B (Code Reviewer)
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   "Review PR #123 for security issues"   │
       │                                  [MAMORU] │← auto task_ack, status→busy
       │◀──────────────────────── task_ack ───────│
       │                                          │
       │◀──────────────────────── task_update ────│
       │   "Found 2 issues so far, still going"   │
       │                                          │
       │◀──────────────────────── task_done ──────│
       │   detail: "/tmp/reviews/pr123.md"        │
       │                                  [MAMORU] │← status→available
```

### Task with Clarification

```
Agent A (Planner)                         Agent B (Developer)
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   "Refactor the auth module"             │
       │                                  [MAMORU] │← auto task_ack, status→busy
       │◀──────────────────────── task_ack ───────│
       │                                          │
       │◀──────────────────────── task_clarify ───│
       │   "Which auth module? OAuth or SAML?"    │
       │                                          │
       │── task_clarify_res ─────────────────────▶│
       │   "The OAuth module in src/auth/oauth"   │
       │                                          │
       │◀──────────────────────── task_done ──────│
       │                                  [MAMORU] │← status→available
```

### Task Rejection (Agent Busy)

```
Agent A (Planner)                         Agent B (Developer) [status=busy]
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   "Write the database migration"         │
       │                                  [MAMORU] │← auto task_reject (busy)
       │◀──────────────────────── task_reject ────│
       │   "Agent is currently busy. Try again    │
       │    later or send to another agent."      │
```

### Task Sub-Delegation

When a worker needs help from another agent, it becomes a new requester with a fresh `task_req` and independent `task_id`. No special chaining — each task is self-contained.

```
Agent A (Planner)          Agent B (Developer)          Agent C (Tester)
       │                          │                            │
       │── task_req ─────────────▶│  (message_id=42, task_id=42)
       │   "Build auth feature"   │                            │
       │◀──── task_ack ──────────│  (task_id=42, ref=42)       │
       │                          │                            │
       │                          │── task_req ────────────────▶│  (message_id=78, task_id=78)
       │                          │   "Write tests for oauth"  │
       │                          │◀──── task_ack ────────────│  (task_id=78, ref=78)
       │                          │◀──── task_done ───────────│  (task_id=78, ref=78)
       │                          │                            │
       │◀──── task_done ─────────│  (task_id=42, ref=42)       │
```

---

## MAMORU: The Guardian Process

Each agent runs a **MAMORU** (守る, Japanese for "to protect/guard") background loop — a non-LLM process that handles message I/O, status management, and automatic responses. Only messages that require actual reasoning reach the LLM.

### Why MAMORU?

Most message events don't need LLM involvement. Acknowledging a ping, accepting a task, rejecting because the agent is busy — these are deterministic operations. Running every message through the LLM would be wasteful, slow, and could interrupt in-progress work.

### Architecture

```
                     ┌──────────────────────────────┐
                     │         Agent Process         │
                     │                               │
  SQLite ◄──poll──── │  ┌─────────┐    ┌─────────┐  │
  messages           │  │ MAMORU  │───▶│   LLM   │  │
  table  ────read──▶ │  │ (loop)  │◀───│ session │  │
                     │  └─────────┘    └─────────┘  │
                     │   auto-reply      task work   │
                     │   status mgmt     reasoning   │
                     │   roster mgmt                 │
                     └──────────────────────────────┘
```

### Polling

MAMORU polls the SQLite database every **1 second** (configurable). The poll query (`SELECT ... WHERE message_id > ? LIMIT N`) is an index seek on an integer primary key — sub-millisecond even with thousands of messages. With 10 agents polling every second, that's 10 trivial reads per second. WAL mode handles concurrent readers without blocking.

No WebSocket server, no filesystem watchers, no message broker. Simple polling is cheap enough to be the right answer.

### Auto-Handled Events (No LLM)

| Incoming Event | MAMORU Action |
|---------------|---------------|
| `ping` | Auto-reply `pong`. Update `last_heartbeat`. |
| `task_req` (status=`available`) | Auto-reply `task_ack`. Set status → `busy`. Forward task to LLM. |
| `task_req` (status=`busy`) | Auto-reply `task_reject` with reason "busy". |
| `task_cancel` | Interrupt LLM. Auto-reply `task_cancel_ack`. Set status → `available`. |
| `broadcast` (intent=`agent_join`) | Add agent to in-memory roster. Refresh `send_message` tool description. |
| `broadcast` (intent=`agent_leave`) | Remove agent from roster. Refresh `send_message` tool description. |
| `broadcast` (intent=`agent_status_change`) | Update roster entry. Refresh tool description. |
| `task_ack` | Note acknowledgement. No action needed. |
| `task_cancel_ack` | Note cancellation confirmed. Set status → `available`. |

### LLM-Forwarded Events

| Incoming Event | Why LLM Needed |
|---------------|----------------|
| `task_req` (after auto-ack) | LLM performs the actual task work. |
| `task_clarify` | LLM must compose the clarification answer. |
| `task_clarify_res` | LLM uses the new info to continue work. |
| `task_reject` | LLM must decide which alternative agent to try. |
| `task_done` | LLM processes the result from the worker. |
| `task_fail` | LLM decides how to handle the failure. |

### Outbound Message Handling

When the LLM sends a message via the `send_message` tool, MAMORU manages status transitions:

| Outbound Event | MAMORU Action |
|---------------|---------------|
| `task_done` | Send message. Set status → `available`. |
| `task_fail` | Send message. Set status → `available`. |
| `task_update` | Send message. Status stays `busy`. |
| `task_clarify` | Send message. Status stays `busy` (awaiting response). |
| All others | Send message. No status change. |

### The Live Roster

MAMORU maintains an **in-memory roster** of all teammates. This roster is embedded directly into the `send_message` tool's description, which is rewritten whenever the roster changes:

```
send_message: Send a message to a teammate or broadcast to the team.

Available teammates:
  - "Designer" (session: abc123) — available — UI/UX designer with modern tastes...
  - "Tester" (session: def456) — busy — Code reviewer and functional tester...
```

The LLM never queries the database for teammates — it sees the current state directly in the tool description. When a teammate joins, leaves, or changes status, MAMORU refreshes the description so the LLM's next turn always has current information.

**Roster update triggers:**
- `broadcast` with intent `agent_join` → add to roster
- `broadcast` with intent `agent_leave` → remove from roster
- `broadcast` with intent `agent_status_change` → update status
- Stale heartbeat detected → mark `inactive`

### Heartbeat & Liveness

1. **Passive:** Every time MAMORU polls or processes a message, it updates `last_heartbeat` in the `agents` table.
2. **Active:** Other agents can send `ping`. If no `pong` within **20 seconds**, the sender's MAMORU marks the target as `inactive`.

An `inactive` agent is excluded from the roster (removed from the `send_message` tool description). If the agent comes back online, its MAMORU updates the heartbeat, sets status back to `available`, and broadcasts `agent_status_change`.

### Status Lifecycle

```
                  ┌──────────────┐
         join ───▶│  available   │◀─── task_done / task_fail / task_cancel_ack
                  └──────┬───────┘
                         │ task_req received (auto task_ack)
                         ▼
                  ┌──────────────┐
                  │     busy     │
                  └──────┬───────┘
                         │ no heartbeat / crash
                         ▼
                  ┌──────────────┐
                  │   inactive   │
                  └──────────────┘
```

---

## Task Timeout

Tasks have a configurable timeout to prevent zombie work:

- **Default timeout:** 20 minutes.
- **Timer resets** on any task-related event from the worker (`task_update`, `task_clarify`, etc.).
- If the timer expires with no events from the worker:
  1. The requester's MAMORU sends `task_cancel` to the worker.
  2. If no `task_cancel_ack` within 20 seconds, the worker is marked `inactive`.
  3. The requester's LLM is notified so it can reassign.

Workers should send periodic `task_update` messages during long-running work to prevent timeout.

---

## Scaling: Multiple Same-Role Agents

Each agent handles **one task at a time**. To achieve parallelism, deploy multiple agents with the same role:

```yaml
# Agent instance 1                    # Agent instance 2
name: "Code Reviewer 1"               name: "Code Reviewer 2"
```

The LLM picks the right agent naturally from the `send_message` tool description — it can see who's available and who's busy. If the chosen agent happens to be busy (race condition between poll cycles), MAMORU auto-rejects and the LLM picks another on the next turn.

Since the team is fully decentralized, scaling up is as simple as opening a new terminal and joining. No configuration changes, no restarts for existing agents.

---

## Further Reading

- [Why Build a Teammate System?](00-why-build-teammate.md) — The motivation behind teammate vs. subagent architectures
- [Designing a Teammate-Based Multi-Agent System](01-teammate-design.md) — Architecture, design principles, and a walkthrough example
- [Command Reference](03-command-reference.md) — Complete manual for CLI flags, slash commands, and TUI shortcuts
