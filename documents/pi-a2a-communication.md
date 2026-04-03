# Pi Agent-to-Agent Communication (Pi ↔ Pi)

> How can 2+ pi agents (each running in separate terminal REPLs) communicate with each other?

## The Core Problem

When multiple pi agents run in separate terminals, they need **peer-to-peer** communication without a pre-designated server. WebSocket has a "who is server?" asymmetry problem — one agent must be special. This gets worse at N>2 where a full mesh requires N×(N-1)/2 connections.

---

## Four Approaches Considered

### 1. Shared SQLite Message Bus ✅ Recommended

All agents read/write to a shared SQLite database. No server, no special roles — every agent is an equal peer.

**Architecture:**

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Agent A  │    │ Agent B  │    │ Agent C  │
│  (REPL)  │    │  (REPL)  │    │  (REPL)  │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     │  read/write   │  read/write   │  read/write
     └───────────┐   │   ┌───────────┘
                 ▼   ▼   ▼
           ┌─────────────────┐
           │  shared.sqlite  │
           │  (WAL mode)     │
           │                 │
           │  messages table │
           │  agents table   │
           └─────────────────┘
```

**How it works:**

- Each agent loads a pi extension that registers it in an `agents` table on startup.
- The extension polls for new messages every 100-500ms (cheap with SQLite).
- Agents send messages via a custom tool exposed to the LLM: `send_message({ to: "agent-b", payload: "..." })`.
- Broadcast is supported: `send_message({ channel: "planning", payload: "..." })`.
- Incoming messages surface via a TUI widget or get injected as context.
- Agents maintain liveness via heartbeat updates; stale agents are detected.

**One SQLite file per task/session cycle.** Each coordinated multi-agent task should use its own dedicated SQLite file (e.g., `~/.pi/buses/refactor-auth-2026-03-29.sqlite`). There's no reason to mix unrelated tasks into a single database — separate files keep things clean, make cleanup trivial (delete the file when done), and avoid cursor/channel collisions between unrelated work. When the task is complete, the file serves as a self-contained audit log or can simply be discarded.

---

### Schema

```sql
CREATE TABLE agents (
  session_id TEXT PRIMARY KEY, -- pi session ID
  agent_name TEXT,             -- human-friendly name, e.g., "planner"
  cwd TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'deactive')),
  last_heartbeat INTEGER       -- epoch ms, for liveness detection
);

CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,    -- session_id of sender
  to_agent TEXT,               -- session_id for direct message, NULL for broadcast
  channel TEXT NOT NULL,       -- group identifier (e.g., initiating session_id)
  type TEXT NOT NULL CHECK (type IN ('prompt', 'pause', 'continue', 'close')),
  payload TEXT NOT NULL,       -- JSON, must contain {"content": "...", ...}
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (from_agent) REFERENCES agents(session_id)
);

-- Recipient-side cursor tracking (each agent tracks their own read position)
CREATE TABLE agent_cursors (
  session_id TEXT NOT NULL,    -- the reading agent
  channel TEXT NOT NULL,       -- which channel they're tracking
  last_read_id INTEGER DEFAULT 0,  -- message_id of last message they've processed
  PRIMARY KEY (session_id, channel),
  FOREIGN KEY (session_id) REFERENCES agents(session_id)
);
```

---

### Cursor-Based Message Delivery

Sender writes 1 row, recipients pull.

**Sending** (direct or broadcast): Sender inserts a single row into `messages`. That's it — no fan-out, no N writes.

**Receiving**: Each agent polls for messages newer than their cursor:

```sql
-- Get unread messages for an agent on a channel
SELECT m.* FROM messages m
LEFT JOIN agent_cursors ac
  ON ac.session_id = ? AND ac.channel = m.channel
WHERE m.channel = ?
  AND m.message_id > COALESCE(ac.last_read_id, 0)
  AND m.from_agent != ?
ORDER BY m.message_id;
```

**Marking as read**: Agent advances their cursor after processing:

```sql
INSERT INTO agent_cursors (session_id, channel, last_read_id)
VALUES (?, ?, ?)
ON CONFLICT (session_id, channel)
DO UPDATE SET last_read_id = excluded.last_read_id;
```

**Direct messages**: Use a private channel (e.g., deterministic ID from both session_ids: `dm:<sorted-id-a>:<sorted-id-b>`), or filter via `to_agent`:

```sql
-- Unread direct messages for me
SELECT m.* FROM messages m
LEFT JOIN agent_cursors ac
  ON ac.session_id = ? AND ac.channel = m.channel
WHERE m.to_agent = ?
  AND m.message_id > COALESCE(ac.last_read_id, 0)
ORDER BY m.message_id;
```

**Late joiners**: A new agent joining a channel can set their cursor to 0 (see all history) or to `MAX(message_id)` (start fresh). No missed messages.

---

### Why Cursors Over Recipient Fan-Out

An alternative design uses a `message_recipients` table where the sender writes N rows (one per recipient) on broadcast. Cursors are better:

| Concern | Fan-out (`message_recipients`) | Cursors (`agent_cursors`) |
|---|---|---|
| Sender writes | 1 message + N recipient rows | 1 message row |
| Late joiners | Miss earlier broadcasts | See full history (or skip) |
| Agent count coupling | Sender must know all recipients | Sender is decoupled |
| Storage | O(messages × agents) | O(channels × agents) |
| Complexity | Sender does fan-out + cleanup | Each agent manages own cursor |

---

### Strengths

- **No server** — all agents are equal peers, just readers/writers.
- **Scales to N agents** trivially — 2, 3, 5, 50, doesn't matter.
- **WAL mode** allows concurrent reads + one writer without blocking.
- **Built into Bun** — `bun:sqlite`, zero dependencies.
- **Persistent** — messages survive crashes, agents can join/leave.
- **Ordered** — SQLite gives monotonic rowids for message ordering.
- **Discoverable** — agents register themselves; others can query who's online.
- **Queryable** — "show me all unread messages on the `planning` channel" is a simple SQL query.

### Tradeoffs

- Polling (not push) — but 100ms polling on SQLite is negligible for agent-to-agent coordination (agents think in seconds, not milliseconds).
- All agents must agree on the DB path for a given task.

---

### Implementation as Pi Extension

A single pi extension that each agent loads, exposing:

1. **A custom tool** (`send_message`) so the LLM can send messages to other agents.
2. **A TUI widget** showing incoming messages / agent roster.
3. **Event injection** so incoming messages appear in the agent's context automatically.

---

## Other Approaches Considered

### 2. Filesystem Mailbox

Each agent gets an inbox directory. Sending = writing a JSON file. Receiving = watching the directory with `fs.watch`.

```
~/.pi/mailbox/
├── agent-a/          # Agent A's inbox
│   ├── 001.json
│   └── 002.json
├── agent-b/          # Agent B's inbox
│   └── 001.json
└── _registry.json    # Who's alive
```

**Strengths:** Dead simple, zero dependencies. `fs.watch` for near-real-time delivery.

**Weaknesses:** No ordering guarantees across agents. Cleanup is manual. Race conditions on the registry file. Harder to do broadcast/channels elegantly.

---

### 3. Hub-Spoke with Auto-Election (WebSocket)

Solve the "who is server?" problem with **auto-election**:

- First agent to start claims a known port (e.g., 9900) → becomes the hub.
- Subsequent agents try to connect; if the port is taken, they join as spokes.
- If the hub dies, a spoke detects the disconnect and claims the port.

**Strengths:** Real-time push, true bidirectional.

**Weaknesses:** Complex leader election logic. Transient message loss during failover. Harder to reason about. Overkill for most pi agent coordination use cases.

---

### 4. External Broker (Redis pub/sub, NATS)

All agents connect as clients to an external message broker.

**Strengths:** Battle-tested, real-time, scales infinitely.

**Weaknesses:** External dependency to install and run. Violates pi's "just works" philosophy.

---

## Decision Matrix

| Criterion              | SQLite Bus    | Filesystem    | WebSocket Hub   | External Broker |
|------------------------|:------------:|:-------------:|:---------------:|:---------------:|
| No server needed       | ✅           | ✅            | ❌ (elected)    | ❌              |
| Scales to N agents     | ✅           | ⚠️ messy      | ✅              | ✅              |
| Zero external deps     | ✅           | ✅            | ✅              | ❌              |
| Message ordering       | ✅           | ❌            | ✅              | ✅              |
| Persistence            | ✅           | ✅            | ❌              | Depends         |
| Broadcast/channels     | ✅ easy      | ⚠️ manual     | ✅              | ✅              |
| Latency                | ~100ms poll  | ~50ms watch   | ~1ms push       | ~1ms push       |
| Complexity             | Low          | Very low      | High            | Medium          |
| Agent join/leave       | ✅ heartbeat | ⚠️            | ⚠️ reconnect    | ✅              |

---

## Conclusion

For **multi-agent communication between pi REPL sessions**, the **shared SQLite message bus** is the clear winner. It requires no server, no special agent roles, scales to any number of agents, and leverages Bun's built-in `bun:sqlite` for zero dependencies. The ~100ms polling latency is irrelevant when agents operate on a seconds-to-minutes timescale.

The implementation is a single pi extension loaded by each agent, providing a custom tool for sending, a TUI widget for visibility, and automatic context injection for incoming messages.

