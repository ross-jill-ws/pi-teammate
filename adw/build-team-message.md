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
- **`provider`** and **`model`** are metadata for the team — useful for debugging, cost tracking, and understanding agent capabilities. Not broadcast by default but stored in the `agents` table.
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
  ref_message_id INTEGER,        -- references the original message_id for task correlation
  payload TEXT NOT NULL,          -- JSON (see §3 for schema)
  created_at INTEGER NOT NULL,   -- epoch ms
  FOREIGN KEY (from_agent) REFERENCES agents(session_id),
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
  "need_reply": true,           // whether the recipient should respond
  "content": "Short summary",   // max 500 chars, enforced by the extension
  "detail": "/abs/path/to/file" // optional; file path for large content (task results, specs, etc.)
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event` | string (enum) | The message event type (see below). |
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

### Task Correlation

All task-related replies **must** set `ref_message_id` on the `messages` row to the `message_id` of the original `task_req`. This allows both agents to correlate the full conversation around a task, especially when multiple tasks are in-flight simultaneously.

```
task_req (message_id=42)
  ← task_ack         (ref_message_id=42)
  ← task_clarify     (ref_message_id=42)
  → task_clarify_res (ref_message_id=42)
  ← task_update      (ref_message_id=42)
  ← task_done        (ref_message_id=42)
```

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
       │── task_req(id=42) ──────▶│                            │
       │   "Build auth feature"   │                            │
       │◀──── task_ack ──────────│                            │
       │                          │                            │
       │                          │── task_req(id=78) ────────▶│
       │                          │   "Write tests for oauth"  │
       │                          │◀──── task_ack ────────────│
       │                          │◀──── task_done ───────────│
       │                          │                            │
       │◀──── task_done ─────────│                            │
```

Agent B's `task_req(id=78)` to Agent C is a completely separate task. Agent A has no visibility into this sub-delegation.

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
                     └──────────────────────────────┘
```

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
| `task_req` (status=`available`) | Auto-reply `task_ack`. Set status → `busy`. Forward task to LLM. |
| `task_req` (status=`busy`) | Auto-reply `task_reject` with reason "busy". |
| `task_cancel` | Interrupt LLM. Auto-reply `task_cancel_ack`. Set status → `available`. |
| `broadcast` | Store in context buffer for LLM awareness. No reply. |
| `info_only` | Store in context buffer for LLM awareness. No reply. |
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

### Heartbeat & Liveness

MAMORU handles heartbeat in two ways:

1. **Passive**: Every time MAMORU processes any message or polls, it updates `last_heartbeat` in the `agents` table.
2. **Active**: Other agents (or their MAMORUs) can send `ping`. If no `pong` is received within **20 seconds**, the sender's MAMORU marks the target agent as `inactive`.

An `inactive` agent is excluded from task routing. If the agent comes back online, its MAMORU updates the heartbeat and sets status back to `available`.

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

### Task Routing

When a requester agent needs to send a `task_req`, it (or its MAMORU) queries the `agents` table to find an available agent with a matching role:

```sql
-- Find an available agent by role description (keyword match or exact name)
SELECT session_id, agent_name
FROM agents
WHERE status = 'available'
  AND description LIKE '%code review%'
ORDER BY last_heartbeat DESC
LIMIT 1;
```

If no agent is available, the requester can:
1. **Wait and retry** — poll until an agent becomes `available`.
2. **Queue the task** — store it locally and check periodically.
3. **Report to the user** — "All code reviewers are busy."

The exact routing strategy is up to the requester's LLM or can be handled by MAMORU with simple rules.

---

## 8. Resolved Design Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Task timeout? | Yes. Configurable, default 20min. Resets on any worker event. See §6. |
| 2 | Sub-delegation / chaining? | No chaining. Worker becomes a new requester with a fresh `task_req`. See §4.4. |
| 3 | Message retention? | Keep all data until the mission is complete. Cleanup is out of scope — handled externally or by deleting the SQLite file. |
| 4 | Concurrent task limits? | One task per agent. Use multiple same-role agents for parallelism. MAMORU auto-rejects when busy. See §5 and §7. |
| 5 | Detail file lifecycle? | Out of scope. Can be addressed later by a cleanup extension or convention. |
