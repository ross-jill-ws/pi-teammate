# Building the Agent Team Messaging System

> Design document for agent-to-agent (A2A) communication built on top of our shared SQLite message bus.

## Prerequisites

Read [`documents/pi-a2a-communication.md`](../documents/pi-a2a-communication.md) first to understand the underlying messaging infrastructure.

### Key Takeaways from the Reference Doc

- Any agents coming together can form a **team**, which communicates over a dedicated **channel** backed by its own SQLite database (one file per task/session).
- The A2A communication relies on three tables: `agents`, `messages`, and `agent_cursors`.
- **Cursor-based delivery**: the sender writes one row to `messages`; each recipient tracks their own read position via `agent_cursors`. No sender-side fan-out.

---

## 1. Agent Personas

Each agent should have a `persona.yaml` file in its working directory, describing its identity, capabilities, and boundaries.

```yaml
name: "Code Reviewer"
provider: "anthropic"
model: "claude-opus-4-6"
description: >
  You are a code reviewer. You review code changes for correctness,
  style, and potential bugs, and provide actionable feedback.
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-friendly agent role name. Broadcast to teammates. |
| `provider` | string | LLM provider (e.g., `anthropic`, `openai`, `google`). |
| `model` | string | Model identifier (e.g., `claude-opus-4-6`, `gpt-5.4`). |
| `description` | string | What this agent does. Broadcast to teammates so they know who to delegate tasks to. |

### Design Notes

- **`name`** and **`description`** are broadcast to all teammates on join, so other agents know what this agent can do. The `description` field must also be added to the `agents` table (see updated schema below).
- **`provider`** and **`model`** are internal metadata — useful for debugging and cost tracking. Stored in the `agents` table but **not broadcast** to teammates (they don't need to know your LLM implementation).
- **Skills and MCP tools** are the agent's own equipment and are _not_ broadcast to teammates.

### File Access Control via `pi-file-permissions`

File access boundaries are **not** part of `persona.yaml`. They are managed by the [`pi-file-permissions`](https://github.com/user/pi-file-permissions) extension, which each agent loads independently.

Each agent has a `file-permissions.yaml` in its working directory:

```yaml
domains:
  - path: /Users/me/projects/frontend
    permissions: [read, write, edit, find, grep, ls]
  - path: /Users/me/projects/backend
    permissions: [read, find, grep, ls]
  - path: ~/data/reports
    permissions: [read]
  - path: ./local-docs
    permissions: [read, find, ls]
```

`pi-file-permissions` enforces access at three levels: system prompt injection, tool description overrides, and hard tool-call blocking. See the [extension README](../../pi-file-permissions/README.md) for full details.

This separation keeps concerns clean:
- **`persona.yaml`** = identity and role (shared with teammates)
- **`file-permissions.yaml`** = filesystem boundaries (local enforcement, not shared)

---

## 2. Updated Schema

Changes from the reference doc:

1. **`agents` table**: Add `description TEXT`, `provider TEXT`, `model TEXT`. Change `status` values to `available | busy | inactive`.
2. **`messages` table**: Remove the `type` column (event type moves into the JSON payload). Remove `updated_at` (immutable messages). Add `ref_message_id` for task correlation.
3. **`agent_cursors` table**: Unchanged — remains a reader-side mechanism.

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

CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,       -- session_id of sender
  to_agent TEXT,                  -- session_id for DM, NULL for broadcast
  channel TEXT NOT NULL,          -- team/group identifier
  task_id INTEGER,               -- the originating task_req's message_id (same for all messages in a task)
  ref_message_id INTEGER,        -- the specific message this is replying to (reply chain)
  payload TEXT NOT NULL,          -- JSON (see §3 for schema)
  created_at INTEGER NOT NULL,   -- epoch ms
  FOREIGN KEY (from_agent) REFERENCES agents(session_id),
  FOREIGN KEY (task_id) REFERENCES messages(message_id),
  FOREIGN KEY (ref_message_id) REFERENCES messages(message_id)
);

-- Reader-side cursor tracking (each agent tracks their own read position)
CREATE TABLE agent_cursors (
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_read_id INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, channel),
  FOREIGN KEY (session_id) REFERENCES agents(session_id)
);
```

### Directory Layout

All team data is stored under `~/.pi/pi-teammate/`:

```
~/.pi/pi-teammate/
└── <channel>/                          # e.g. "mytest"
    ├── team.db                         # shared SQLite database (WAL mode)
    ├── <teammate_A_session_id>/        # detail files produced by teammate A
    │   ├── review-pr123.md
    │   └── test-results.json
    └── <teammate_B_session_id>/        # detail files produced by teammate B
        └── refactor-spec.md
```

- Each channel name maps to exactly **one directory** with **one `team.db`** file.
- Each teammate gets a dedicated subdirectory (keyed by session_id) for storing **detail files** (referenced by the `detail` field in message payloads).
- `--team-new` or `/team-create` deletes the entire `<channel>/` directory and creates a fresh `team.db`.

### Cursor Initialization

When a new agent joins an existing channel, `initCursor` sets `last_read_id` to `MAX(message_id)` — skipping all historical messages. This prevents replay of old messages from before the agent joined. The roster is populated from the `agents` table directly (not from broadcast messages), and existing teammates are injected into the system prompt so the LLM has full context from the start.

### DM vs Broadcast

- **Direct Message (DM):** `to_agent` is set to a specific `session_id`.
- **Broadcast Message (BM):** `to_agent` is `NULL` — all agents on the channel receive it.

In both cases, the **sender writes exactly one row** to `messages`. Each recipient agent detects new messages by polling against their own cursor — no sender-side fan-out is needed.

### Determining Read Status

Read status is derived from cursors, not stored on the message:

```sql
-- Has agent X read message Y?
SELECT CASE
  WHEN ac.last_read_id >= :message_id THEN 1 ELSE 0
END AS is_read
FROM agent_cursors ac
WHERE ac.session_id = :agent_id AND ac.channel = :channel;
```

This avoids the complexity of maintaining an `is_read` flag on the `messages` table — especially for broadcasts, where "read by all" would require tracking N recipients per message.

---

## 3. Message Payload Schema

The `payload` column is a JSON string with the following structure:

```jsonc
{
  "event": "task_req",          // see event types below
  "intent": "code_review",      // freeform hint for the listener (see below)
  "need_reply": true,           // whether the recipient should respond
  "content": "Short summary",   // max 500 chars, enforced by the extension
  "detail": "/abs/path/to/file" // optional; file path for large content (task results, specs, etc.)
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event` | string (enum) | The message event type (see below). |
| `intent` | string \| null | Freeform hint telling the listener what kind of `event` this is. Not an enum — extensible without schema changes. MAMORU uses it as a routing/handling hint. See §3.3 for common intents. |
| `need_reply` | boolean | `true` = recipient must respond. `false` = informational only. |
| `content` | string | Brief message body. Max 500 characters. Enforced at the extension level. |
| `detail` | string \| null | Absolute file path the recipient should read for full context. May reference further files. Use for task results (`task_done`), detailed specs, etc. If `content` alone is sufficient, set to `null`. |

### Event Types

Events are grouped by purpose. **Role** indicates who sends the event relative to the original task request.

#### Informational (no reply expected)

| Event | Role | `need_reply` | Description |
|-------|------|:---:|-------------|
| `broadcast` | any | `false` | Announcement to all agents on the channel. |
| `info_only` | any | `false` | Informational DM to a specific agent. |

#### Liveness

| Event | Role | `need_reply` | Description |
|-------|------|:---:|-------------|
| `ping` | any | `true` | Liveness check. If no `pong` within 20s, mark recipient as `inactive`. |
| `pong` | any | `false` | Response to `ping`. Handled automatically by MAMORU (§5). |

#### Task Lifecycle

| Event | Role | `need_reply` | Description |
|-------|------|:---:|-------------|
| `task_req` | requester → worker | `true` | Request an agent to perform a task. |
| `task_ack` | worker → requester | `false` | Acknowledge receipt; work is starting. |
| `task_reject` | worker → requester | `false` | Decline the task (wrong agent, overloaded, out of scope, etc.). |
| `task_clarify` | worker → requester | `true` | Ask the requester for more information before proceeding. |
| `task_clarify_res` | requester → worker | `false` | Provide the requested clarification. |
| `task_update` | worker → requester | `false` | Progress update while work is in-flight. |
| `task_done` | worker → requester | `false` | Task completed. Result is in `content` and/or `detail`. |
| `task_fail` | worker → requester | `false` | Task failed. Reason is in `content`. |
| `task_cancel` | requester → worker | `true` | Request cancellation of an in-flight task. |
| `task_cancel_ack` | worker → requester | `false` | Acknowledge cancellation. |

### Common Intents

The `intent` field is freeform, but these are the conventional values:

| Event | Intent | Description |
|-------|--------|-------------|
| `broadcast` | `agent_join` | Agent introducing itself to the team (name + description). |
| `broadcast` | `agent_leave` | Agent announcing it's going offline. |
| `broadcast` | `agent_status_change` | Agent status changed (e.g., busy → available). |
| `task_req` | _(domain-specific)_ | Hints at the kind of work, e.g., `code_review`, `write_tests`, `refactor`. |
| `task_update` | `task_progress` | Periodic progress update. |
| `task_cancel` | `task_timeout` | Cancellation due to timeout (vs. explicit user/agent cancellation). |

MAMORU uses `intent` to decide how to handle a message (e.g., `agent_join` triggers roster update, `agent_status_change` triggers tool description refresh). The LLM never needs to parse `intent` — it's a machine-to-machine hint.

### Task Correlation: `task_id` vs `ref_message_id`

These two fields serve different purposes:

- **`task_id`** — the originating `task_req`'s `message_id`. **Same for ALL messages in a task conversation.** This is the **correlation key** that groups an entire task lifecycle together.
- **`ref_message_id`** — which specific message this is directly responding to. This is the **reply chain** for conversational threading.

For `task_req` itself: `task_id` = its own `message_id` (self-referencing), `ref_message_id` = `NULL`.
For non-task messages (`broadcast`, `info_only`, `ping`, `pong`): both are `NULL`.

```
task_req       (message_id=42, task_id=42,  ref_message_id=NULL)
  ← task_ack         (message_id=43, task_id=42,  ref_message_id=42)
  ← task_clarify     (message_id=44, task_id=42,  ref_message_id=42)
  → task_clarify_res (message_id=45, task_id=42,  ref_message_id=44)  ← replies to the clarify
  ← task_update      (message_id=46, task_id=42,  ref_message_id=42)
  ← task_done        (message_id=47, task_id=42,  ref_message_id=42)
```

### Message Delivery

When MAMORU forwards a message to the LLM via `pi.sendUserMessage()`, it must decide the delivery mode. The routing key is `task_id`:

| Condition | Delivery | Rationale |
|-----------|----------|----------|
| `task_id == message_id` | _MAMORU auto-handles_ | New `task_req` — auto-ack/auto-reject. Never reaches `forwardToLlm`. |
| Everything else | `steer` | If it passed MAMORU's auto-handling and needs LLM attention, it's relevant now. |

That's it — two rules. A new `task_req` is identified by `task_id == message_id` (self-referencing). The LLM already knows agent availability via the `send_message` tool roster description, so it wouldn't send a task to a busy agent in the first place. Everything that reaches `forwardToLlm` is always `steer`.

---

## 4. Example Flows

### 4.1 Simple Task Request

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

### 4.2 Task with Clarification

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

### 4.3 Task Rejection (Agent Busy)

```
Agent A (Planner)                         Agent B (Developer) [status=busy]
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   "Write the database migration"         │
       │                                  [MAMORU] │← auto task_reject (busy)
       │◀──────────────────────── task_reject ────│
       │   "Agent is currently busy with another  │
       │    task. Try again later or send to       │
       │    another available agent."              │
```

### 4.4 Task Sub-Delegation

When a worker needs help from another agent, it becomes a **new requester** with a fresh `task_req` and independent `message_id`. There is no chaining — each task is self-contained.

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
       │                          │  not a new task (78≠msg_id)│
       │                          │  → steer to B's LLM       │
       │                          │                            │
       │◀──── task_done ─────────│  (task_id=42, ref=42)       │
```

No special sub-delegation logic needed. C's `task_done` has `task_id ≠ message_id`, so it's not a new task — MAMORU steers it to B's LLM.

---

## 5. MAMORU: The Guardian Process

Each agent runs a **MAMORU** (守る, "to protect/guard") background process — a non-LLM loop that handles message I/O, status management, and automatic responses. MAMORU acts as a gatekeeper: only messages that require LLM reasoning are forwarded to the agent's LLM session.

### Why MAMORU?

Most message events don't need LLM involvement. Acknowledging a ping, accepting a task, or rejecting because the agent is busy are deterministic operations. Running every message through the LLM would be wasteful, slow, and could interrupt in-progress work. MAMORU handles the mechanical parts so the LLM can focus on actual tasks.

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

### Polling Interval

MAMORU polls the SQLite database on a configurable interval:

```yaml
# MAMORU config
poll_interval_ms: 1000    # default
```

**1 second is the right default.** The poll query (`SELECT ... WHERE message_id > ? LIMIT N`) is an index seek on an integer primary key — sub-millisecond even with thousands of messages. With 10 agents polling every 1s, that's 10 reads/second total on the SQLite file. WAL mode handles concurrent readers without blocking — this is negligible load.

1s polling makes the system feel responsive: `task_ack` comes back almost instantly, `ping`/`pong` gets 20 poll cycles within the 20s timeout, and status changes propagate quickly across the team.

No need for WebSocket, filesystem watchers, or anything fancier. The whole appeal of the SQLite bus is that simple polling is cheap enough to be the right answer.

### Status Lifecycle

MAMORU maintains the agent's status in the `agents` table:

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

### Auto-Handled Events (No LLM)

| Incoming Event | MAMORU Action |
|---------------|---------------|
| `ping` | Auto-reply `pong`. Update `last_heartbeat`. |
| `task_req` (status=`available`) | Auto-reply `task_ack`. Set status → `busy`. Set `activeTaskId`. Forward task to LLM. |
| `task_req` (status=`busy`) | Auto-reply `task_reject` with reason "busy". |
| `task_cancel` | Interrupt LLM. Auto-reply `task_cancel_ack`. Set status → `available`. Clear `activeTaskId`. |
| `broadcast` (intent=`agent_join`) | Add agent to in-memory roster. Refresh `send_message` tool description. |
| `broadcast` (intent=`agent_leave`) | Remove agent from roster. Refresh `send_message` tool description. |
| `broadcast` (intent=`agent_status_change`) | Update roster entry. Refresh `send_message` tool description. |
| `broadcast` / `info_only` (other) | Store in context buffer for LLM awareness. No reply. |
| `task_ack` | Note acknowledgement. No action needed. |
| `task_reject` | Forward to LLM so it can choose another agent. |
| `task_cancel_ack` | Note cancellation confirmed. Set status → `available`. |

### LLM-Forwarded Events

| Incoming Event | Why LLM Needed |
|---------------|----------------|
| `task_req` (after auto-ack) | LLM performs the actual task work. |
| `task_clarify` | LLM must compose the clarification answer. |
| `task_clarify_res` | LLM uses the new info to continue work. |
| `task_reject` | LLM must decide which alternative agent to try. |
| `task_done` | LLM processes the result from the worker. |
| `task_fail` | LLM decides how to handle the failure (retry, reassign, etc.). |

### LLM → MAMORU Outbound

When the LLM finishes work or needs to communicate, it uses the `send_message` tool. MAMORU intercepts outbound messages to manage status:

| Outbound Event | MAMORU Action |
|---------------|---------------|
| `task_done` | Send message. Set status → `available`. |
| `task_fail` | Send message. Set status → `available`. |
| `task_update` | Send message. Status stays `busy`. |
| `task_clarify` | Send message. Status stays `busy` (awaiting response). |
| All others | Send message. No status change. |

### Teammate Roster & Dynamic `send_message` Description

MAMORU maintains an **in-memory roster** of all teammates, updated in real-time via broadcast messages and heartbeat checks. This roster is embedded into the `send_message` tool's description, which is rewritten whenever the roster changes:

```
send_message: Send a message to a teammate or broadcast to the team.
Use event 'task_req' to request work or ask a question (expects a response).
Use task_done/task_fail/task_update/task_clarify for task lifecycle.
Use broadcast/info_only for announcements (no response expected).

Available teammates:
  - "Code Reviewer 1" (session: abc123) — available — Reviews code for correctness and bugs
  - "Code Reviewer 2" (session: def456) — busy — Reviews code for correctness and bugs
  - "Tester" (session: ghi789) — available — Writes and runs test suites
```

The LLM never queries the database for teammates — it sees the current state directly in the tool description and naturally picks the right agent. When a teammate joins, leaves, or changes status, MAMORU refreshes the tool description so the LLM's next turn always has current information.

**Roster update triggers:**
- `broadcast` with intent `agent_join` → add to roster
- `broadcast` with intent `agent_leave` → remove from roster
- `broadcast` with intent `agent_status_change` → update status
- Stale heartbeat detected → mark `inactive`, update roster

### Heartbeat & Liveness

MAMORU handles heartbeat in two ways:

1. **Passive**: Every time MAMORU processes any message or polls, it updates `last_heartbeat` in the `agents` table.
2. **Active**: Other agents (or their MAMORUs) can send `ping`. If no `pong` is received within **20 seconds**, the sender's MAMORU marks the target agent as `inactive`.

An `inactive` agent is excluded from task routing (removed from `send_message` tool description). If the agent comes back online, its MAMORU updates the heartbeat, sets status back to `available`, and broadcasts `agent_status_change`.

### System Prompt Injection

MAMORU injects context into every LLM turn via `before_agent_start`:

1. **Persona**: Agent name and description from `persona.yaml`.
2. **Roster**: All known teammates with session_ids and descriptions. This handles the case where late joiners miss `agent_join` broadcasts due to cursor skip-to-MAX.
3. **Active task context**: When busy, includes the requester's name, session_id, and task_id — with explicit `to=` and `task_id=` instructions for the reply.

---

## 6. Task Timeout

Tasks have a configurable timeout to prevent zombie work. The timeout is **not hardcoded** — it can be set per-team or per-task.

### Behavior

- **Default timeout**: 20 minutes.
- **Timer resets** on any task-related event from the worker: `task_update`, `task_clarify`, or any message with the same `ref_message_id`.
- If the timer expires with no events from the worker, the requester's MAMORU:
  1. Sends `task_cancel` to the worker.
  2. If no `task_cancel_ack` within 20s, marks the worker as `inactive`.
  3. Notifies the requester LLM of the timeout so it can reassign.

### Configuration

Timeout is set in the team/channel configuration (exact format TBD, but conceptually):

```yaml
# team config or passed at channel creation
task_timeout_minutes: 20   # default
ping_timeout_seconds: 20   # default
```

Workers should send periodic `task_update` messages during long-running work to prevent timeout. This is a best practice the LLM should be instructed about via system prompt.

---

## 7. Scaling with Multiple Same-Role Agents

Each agent handles **one task at a time** (single-task concurrency). To achieve parallelism, deploy **multiple agents with the same role but different names**:

```yaml
# Agent instance 1                    # Agent instance 2
name: "Code Reviewer 1"               name: "Code Reviewer 2"
provider: "anthropic"                  provider: "anthropic"
model: "claude-opus-4-6"              model: "claude-opus-4-6"
description: >                         description: >
  Code reviewer. Reviews code            Code reviewer. Reviews code
  for correctness and style.             for correctness and style.
```

### Task Routing via `send_message`

The LLM doesn't need to query the database or reason about routing. The `send_message` tool description already shows all teammates and their current status (maintained by MAMORU, see §5).

The LLM picks the right agent naturally from context:

```
// LLM calls:
send_message({ to: "abc123", event: "task_req", content: "Review PR #123 for security issues" })
```

When `send_message` receives `event: "task_req"`, it automatically:
1. Validates the target is in the roster
2. Prevents self-delegation
3. Sets `task_id = message_id` (self-referencing)
4. Registers the outbound task for timeout tracking

**Auto-fill for task replies:** When sending `task_done`, `task_fail`, `task_update`, or `task_clarify` without `to` or `task_id`, the tool auto-fills from MAMORU's `activeTask`. This ensures replies always go to the right agent, even if the LLM omits the fields.

If the chosen agent is busy (race condition between poll cycles), MAMORU auto-rejects with `task_reject` and the LLM picks another agent on the next turn.

If **no agents** are available, the LLM can see that from the tool description and report to the user: "All code reviewers are currently busy."

---

## 8. CLI Flags

```bash
pi --team-channel apollo --agent-name "Planner" --team-new   # first agent, clean start
pi --team-channel apollo --agent-name "Developer"              # joins existing channel
pi --team-channel apollo --agent-name "Reviewer"               # joins existing channel
```

- `--team-channel` + `--agent-name` must be used together.
- `--team-new` deletes the entire channel directory and starts clean. Only the first agent should use it.

---

## 9. Resolved Design Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Task timeout? | Yes. Configurable, default 20min. Resets on any worker event. See §6. |
| 2 | Sub-delegation / chaining? | No chaining. Worker becomes a new requester with a fresh `task_req`. See §4.4. |
| 3 | Message retention? | Keep all data until the mission is complete. Cleanup is out of scope — handled externally or by deleting the SQLite file. |
| 4 | Concurrent task limits? | One task per agent. Use multiple same-role agents for parallelism. MAMORU auto-rejects when busy. See §5 and §7. |
| 5 | Detail file lifecycle? | Out of scope. Files stored in per-teammate directories. |
| 6 | How many tools? | One: `send_message`. Handles `task_req` + all other events. |
| 7 | Delivery mode? | New `task_req` (`task_id == message_id`) → auto-handled. Everything else → `steer`. |
| 8 | Late joiner context? | Cursor skips to MAX. Roster from DB. Teammates injected into system prompt. |
| 9 | Task reply routing? | Auto-fill `to` and `task_id` from `activeTask` when LLM omits them. |
