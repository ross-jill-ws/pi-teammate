# Implementation Plan: pi-teammate

> Step-by-step plan to evolve the current `pi-agent-talk` extension into **`pi-teammate`** — the full team messaging system described in [`build-team-message.md`](./build-team-message.md).

## Current State Assessment

### What Exists

| File | Purpose | Status |
|------|---------|--------|
| `extensions/index.ts` | Channel/DB management, agent registration, polling, `send_agent_message` tool, slash commands | **Partially usable** — needs significant refactoring |
| `extensions/talk-prompt-handler.ts` | Listens for `pi_talk_message` events, forwards every message to LLM, auto-replies | **Replace entirely** — this becomes MAMORU |
| `package.json` | Package config with `better-sqlite3` dependency | **Minor updates** needed |

### Gap Analysis

| Design Requirement | Current Code | Gap |
|--------------------|-------------|-----|
| Updated schema (`description`, `provider`, `model`, `ref_message_id`, `status` enum, no `type` column) | Old schema with `type` column, `deactive` status, no new fields | **Full schema migration** |
| `persona.yaml` loading | Not implemented | **New** |
| MAMORU guardian loop | Simple polling that emits raw events to `pi.events` | **Major rewrite** — needs event routing, auto-responses, status machine |
| Teammate roster (in-memory) | Not implemented | **New** |
| `delegate_task` tool (dynamic description) | `send_agent_message` tool with static description | **Replace** |
| Event/intent-based payload | Messages use `type` column + raw `content` in payload | **Rewrite** message format |
| Task lifecycle state machine | Not implemented | **New** |
| Task timeout | Not implemented | **New** |
| Heartbeat & liveness | Heartbeat updated on poll, but no ping/pong or inactive detection | **Extend** |
| `agent_join`/`agent_leave` broadcasts | Not implemented | **New** |
| System prompt injection (persona) | `talk-prompt-handler.ts` injects ad-hoc prompt for replies | **Rewrite** — inject persona + task context |

---

## File Structure (Target)

```
extensions/
├── index.ts                  # Extension entry point — wires everything together
├── schema.ts                 # SQLite schema init + migration
├── db.ts                     # DB connection helpers, message read/write functions
├── types.ts                  # Shared TypeScript types (MessageRow, Payload, Roster, etc.)
├── persona.ts                # Load & validate persona.yaml
├── mamoru.ts                 # MAMORU guardian loop (poll, route, auto-respond, status)
├── roster.ts                 # In-memory teammate roster, delegate_task tool description builder
├── tools/
│   └── delegate-task.ts      # delegate_task tool definition (dynamic description)
└── commands.ts               # Slash commands (/team-build, /team-join, /team-leave, etc.)
```

---

## Implementation Phases

### Phase 1: Foundation (Schema + Types + DB Layer)

**Goal**: New schema, clean DB access layer, shared types. No behavioral changes yet.

#### 1.1 — `extensions/types.ts`

Define all shared TypeScript types:

```ts
// Agent status
type AgentStatus = "available" | "busy" | "inactive";

// Message event types
type MessageEvent =
  | "broadcast" | "info_only"
  | "ping" | "pong"
  | "task_req" | "task_ack" | "task_reject"
  | "task_clarify" | "task_clarify_res"
  | "task_update" | "task_done" | "task_fail"
  | "task_cancel" | "task_cancel_ack";

// Payload JSON structure
interface MessagePayload {
  event: MessageEvent;
  intent: string | null;
  need_reply: boolean;
  content: string;          // max 500 chars
  detail: string | null;    // absolute file path or null
}

// DB row types
interface AgentRow {
  session_id: string;
  agent_name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  status: AgentStatus;
  last_heartbeat: number | null;
}

interface MessageRow {
  message_id: number;
  from_agent: string;
  to_agent: string | null;
  channel: string;
  ref_message_id: number | null;
  payload: string;           // JSON string
  created_at: number;
}

// Persona config
interface PersonaConfig {
  name: string;
  provider: string;
  model: string;
  description: string;
}

// Roster entry (in-memory)
interface RosterEntry {
  session_id: string;
  agent_name: string;
  description: string;
  status: AgentStatus;
  last_heartbeat: number;
}
```

#### 1.2 — `extensions/schema.ts`

New schema initialization. Drop-and-recreate approach for now (no migration from old schema — this is pre-release).

```sql
CREATE TABLE agents (
  session_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  description TEXT,
  provider TEXT,
  model TEXT,
  cwd TEXT,
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'busy', 'inactive')),
  last_heartbeat INTEGER
);

CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  channel TEXT NOT NULL,
  ref_message_id INTEGER,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_agent) REFERENCES agents(session_id),
  FOREIGN KEY (ref_message_id) REFERENCES messages(message_id)
);

CREATE TABLE agent_cursors (
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_read_id INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, channel),
  FOREIGN KEY (session_id) REFERENCES agents(session_id)
);
```

#### 1.3 — `extensions/db.ts`

Thin wrapper around `better-sqlite3` with prepared statement helpers:

- `openDb(channelName): Database` — open/create DB, set WAL mode, init schema
- `registerAgent(db, agent: AgentRow): void`
- `updateAgentStatus(db, sessionId, status): void`
- `updateHeartbeat(db, sessionId): void`
- `sendMessage(db, msg: Omit<MessageRow, 'message_id'>): number` — returns message_id
- `getUnreadMessages(db, sessionId, channel): MessageRow[]` — cursor-based read
- `advanceCursor(db, sessionId, channel, lastReadId): void`
- `getActiveAgents(db): AgentRow[]` — all non-inactive agents
- `getAgentByName(db, name): AgentRow | null`
- `getAgentBySession(db, sessionId): AgentRow | null`

**Validation**: `sendMessage` validates payload JSON structure and 500-char content limit.

#### 1.4 — `extensions/persona.ts`

Load and validate `persona.yaml` from agent's cwd:

- `loadPersona(cwd: string): PersonaConfig | null`
- Uses `yaml` package (add dependency) or simple parsing
- Returns `null` if file doesn't exist (agent can still work without persona)
- Validates required fields: `name`, `description`
- `provider` and `model` are optional (can fall back to pi's current model)

**Deliverable**: All types defined. DB layer tested via slash command `/team-build`. Persona loads on startup.

---

### Phase 2: MAMORU Core (Poll Loop + Event Router + Status Machine)

**Goal**: Replace `talk-prompt-handler.ts` with MAMORU. Implement the poll loop, event routing, and auto-responses.

#### 2.1 — `extensions/mamoru.ts`

The MAMORU class/module:

```ts
class Mamoru {
  // State
  private db: Database;
  private sessionId: string;
  private channel: string;
  private status: AgentStatus = "available";
  private roster: Map<string, RosterEntry>;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private activeTaskRef: number | null;      // ref_message_id of current task
  private pendingPings: Map<string, number>; // sessionId → sent timestamp

  // Pi integration
  private pi: ExtensionAPI;
  private refreshDelegateTaskTool: () => void;

  // Public
  start(pollIntervalMs: number): void;
  stop(): void;
  getStatus(): AgentStatus;
  getRoster(): RosterEntry[];

  // Internal
  private poll(): void;
  private routeMessage(msg: MessageRow): void;
  private autoRespond(event, fromAgent, refId, content): void;
  private forwardToLlm(msg: MessageRow, parsedPayload: MessagePayload): void;
  private handleOutbound(payload: MessagePayload): void;
}
```

**Event routing logic** (the core of MAMORU):

```
poll() → getUnreadMessages() → for each message:
  parse payload JSON
  switch (payload.event):
    // Auto-handled (no LLM)
    "ping"       → auto-send "pong", update heartbeat
    "pong"       → clear pending ping timer
    "task_ack"   → note (no action)
    "task_cancel_ack" → set status → available, update tool

    // Auto-handled with conditional logic
    "task_req":
      if status === "available":
        auto-send "task_ack"
        set status → "busy", update tool
        store activeTaskRef = msg.message_id
        forwardToLlm(msg)
      else:
        auto-send "task_reject" (reason: "busy")

    "task_cancel":
      abort current LLM operation (pi.abort())
      auto-send "task_cancel_ack"
      set status → "available"
      activeTaskRef = null, update tool

    // Roster updates
    "broadcast" (intent=agent_join):
      update roster, refresh delegate_task
    "broadcast" (intent=agent_leave):
      remove from roster, refresh delegate_task
    "broadcast" (intent=agent_status_change):
      update roster entry, refresh delegate_task
    "broadcast" / "info_only" (other):
      buffer for LLM context

    // Forward to LLM
    "task_clarify"     → forwardToLlm (LLM composes answer)
    "task_clarify_res" → forwardToLlm (LLM continues work)
    "task_reject"      → forwardToLlm (LLM picks another agent)
    "task_done"        → forwardToLlm (LLM processes result)
    "task_fail"        → forwardToLlm (LLM handles failure)

  advanceCursor()
  updateHeartbeat()
```

**`forwardToLlm` implementation**: Use `pi.sendUserMessage()` with a structured prompt that includes the message context:

```
[TEAM MESSAGE from "Code Reviewer" (task ref #42)]
Event: task_done
Content: Review complete. Found 2 security issues.
Detail: /tmp/reviews/pr123.md

Respond appropriately. If the task is complete, acknowledge the result.
If the task failed, decide whether to retry or reassign.
```

**Outbound handling**: Hook into `tool_result` event for `delegate_task` tool. When the LLM sends a message via the tool, MAMORU intercepts and manages status transitions:
- `task_done` / `task_fail` → status → `available`
- `task_update` / `task_clarify` → status stays `busy`

#### 2.2 — Status machine integration

MAMORU updates the `agents` table **and** broadcasts status changes:

```ts
private setStatus(newStatus: AgentStatus): void {
  if (newStatus === this.status) return;
  this.status = newStatus;
  updateAgentStatus(this.db, this.sessionId, newStatus);

  // Broadcast to teammates
  sendMessage(this.db, {
    from_agent: this.sessionId,
    to_agent: null,
    channel: this.channel,
    ref_message_id: null,
    payload: JSON.stringify({
      event: "broadcast",
      intent: "agent_status_change",
      need_reply: false,
      content: `${this.agentName} is now ${newStatus}`,
      detail: null
    }),
    created_at: Date.now()
  });

  this.refreshDelegateTaskTool();
}
```

**Deliverable**: MAMORU polls, routes events, auto-responds to ping/task_req/task_cancel, forwards task work to LLM. Status transitions work correctly. `talk-prompt-handler.ts` is deleted.

---

### Phase 3: Roster + `delegate_task` Tool

**Goal**: Dynamic teammate discovery and task delegation.

#### 3.1 — `extensions/roster.ts`

In-memory roster management:

```ts
class Roster {
  private entries: Map<string, RosterEntry>;  // keyed by session_id

  update(entry: RosterEntry): void;
  remove(sessionId: string): void;
  markInactive(sessionId: string): void;
  getAll(): RosterEntry[];
  getAvailable(): RosterEntry[];
  buildToolDescription(selfSessionId: string): string;

  // Initialize from DB on startup (catch up with existing agents)
  initFromDb(db: Database, selfSessionId: string): void;
}
```

`buildToolDescription()` generates the dynamic tool description string:

```ts
buildToolDescription(selfSessionId: string): string {
  const others = this.getAll().filter(e => e.session_id !== selfSessionId);
  if (others.length === 0) {
    return "Assign a task to a teammate. No teammates are currently online.";
  }

  const lines = others.map(e =>
    `  - "${e.agent_name}" (session: ${e.session_id}) — ${e.status} — ${e.description}`
  );

  return [
    "Assign a task to a teammate.",
    "",
    "Available teammates:",
    ...lines,
    "",
    "Pick an 'available' agent whose description matches the task.",
    "If no suitable agent is available, report that to the user."
  ].join("\n");
}
```

#### 3.2 — `extensions/tools/delegate-task.ts`

The `delegate_task` tool definition:

```ts
parameters: Type.Object({
  to: Type.String({ description: "session_id of the target agent" }),
  task: Type.String({ description: "Task description (max 500 chars)" }),
  detail: Type.Optional(Type.String({ description: "Absolute file path with full task spec" })),
  intent: Type.Optional(Type.String({ description: "Freeform task type hint, e.g. 'code_review'" }))
})
```

**execute()** implementation:
1. Validate target exists in roster
2. Insert `task_req` message into DB with `ref_message_id: null` (this IS the originating message)
3. Return the `message_id` to the LLM so it can correlate future responses
4. MAMORU on the recipient side handles the rest

**Dynamic re-registration**: When roster changes, MAMORU calls `pi.registerTool()` again with the updated description. Pi's extension API allows re-registering a tool with the same name — the new definition replaces the old one.

#### 3.3 — Roster initialization on join

When an agent registers on a channel:
1. Read all existing agents from `agents` table → populate roster
2. Broadcast `agent_join` with own name + description
3. Register `delegate_task` tool with current roster description

**Deliverable**: Agents discover each other automatically. LLM sees live teammate status in `delegate_task` tool. Task routing works.

---

### Phase 4: Task Lifecycle + Timeout

**Goal**: Full task_req → task_done flow with timeout protection.

#### 4.1 — Task state tracking in MAMORU

```ts
// Requester side — tracks tasks this agent has delegated
private outboundTasks: Map<number, {  // keyed by message_id of task_req
  workerSessionId: string;
  sentAt: number;
  lastEventAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}>;

// Worker side — tracks the single active task
private activeTask: {
  refMessageId: number;
  requesterSessionId: string;
  startedAt: number;
} | null;
```

#### 4.2 — Timeout implementation

On the **requester side**, when `task_req` is sent:

```ts
private startTaskTimeout(messageId: number, workerSessionId: string): void {
  const timeoutMs = this.config.taskTimeoutMinutes * 60 * 1000;

  const timer = setTimeout(() => {
    // Send task_cancel with intent "task_timeout"
    sendMessage(this.db, {
      from_agent: this.sessionId,
      to_agent: workerSessionId,
      channel: this.channel,
      ref_message_id: messageId,
      payload: JSON.stringify({
        event: "task_cancel",
        intent: "task_timeout",
        need_reply: true,
        content: `Task timed out after ${this.config.taskTimeoutMinutes} minutes with no updates.`,
        detail: null
      }),
      created_at: Date.now()
    });

    // Start 20s grace period for task_cancel_ack
    setTimeout(() => {
      if (this.outboundTasks.has(messageId)) {
        // No ack received — mark worker inactive
        this.roster.markInactive(workerSessionId);
        this.refreshDelegateTaskTool();
        // Forward timeout to LLM for reassignment
        this.forwardTimeoutToLlm(messageId, workerSessionId);
      }
    }, this.config.pingTimeoutSeconds * 1000);
  }, timeoutMs);

  this.outboundTasks.set(messageId, {
    workerSessionId,
    sentAt: Date.now(),
    lastEventAt: Date.now(),
    timeoutTimer: timer
  });
}
```

**Timer reset**: When requester's MAMORU receives any message with matching `ref_message_id` (`task_update`, `task_clarify`, etc.), reset the timer:

```ts
private resetTaskTimeout(refMessageId: number): void {
  const task = this.outboundTasks.get(refMessageId);
  if (!task) return;
  clearTimeout(task.timeoutTimer);
  task.lastEventAt = Date.now();
  this.startTaskTimeout(refMessageId, task.workerSessionId);
}
```

#### 4.3 — LLM system prompt injection

Use `before_agent_start` event to inject task context into the system prompt when the LLM is handling a forwarded message:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const persona = mamoru.getPersona();
  const activeTask = mamoru.getActiveTask();

  let additions = "";

  // Always inject persona
  if (persona) {
    additions += `\n\nYou are ${persona.name}. ${persona.description}`;
  }

  // Inject active task context if working on something
  if (activeTask) {
    additions += `\n\nYou are currently working on a task (ref #${activeTask.refMessageId}) `;
    additions += `requested by agent "${activeTask.requesterName}". `;
    additions += `When done, use delegate_task or send_message to report back with task_done or task_fail.`;
    additions += `\nSend periodic task_update messages to prevent timeout.`;
  }

  if (additions) {
    return { systemPrompt: event.systemPrompt + additions };
  }
});
```

**Deliverable**: Full task lifecycle works end-to-end. Timeouts fire correctly. LLM has task context in every turn.

---

### Phase 5: Commands + UX Polish

**Goal**: Clean up slash commands, add TUI widget, production polish.

#### 5.1 — `extensions/commands.ts`

Refactor slash commands from current `index.ts`. Rename for consistency:

| Old Command | New Command | Description |
|-------------|-------------|-------------|
| `/agent-talk-build` | `/team-create` | Create a new channel DB |
| `/agent-talk-register` | `/team-join` | Join a channel, start MAMORU |
| _(new)_ | `/team-leave` | Leave channel, broadcast `agent_leave`, stop MAMORU |
| `/agent-talk-to` | `/team-send` | Send a manual message (for debugging/testing) |
| _(new)_ | `/team-status` | Show current status, roster, active task |
| _(new)_ | `/team-roster` | Show all agents on the channel with status |
| _(new)_ | `/team-history` | Show recent messages (last N) |

#### 5.2 — TUI Widget

Replace the simple single-line widget with a richer display:

```
┌─ team: project-alpha ─────────────────────────┐
│ ● Code Reviewer (you) — available              │
│ ○ Developer 1 — busy (task #42)                │
│ ○ Tester — available                           │
│ Last: task_done from Developer 1 (2s ago)      │
└────────────────────────────────────────────────┘
```

Use `ctx.ui.setWidget()` with component factory for rich rendering (pi supports this via the `(tui, theme) => Component` overload).

#### 5.3 — Cleanup

- Delete `extensions/talk-prompt-handler.ts`
- Remove it from `package.json` `pi.extensions` array
- Update `package.json` dependencies (add `yaml` if needed for persona parsing)
- Add `mamoru.ts` and other new files aren't direct extension entry points — only `index.ts` is registered in `pi.extensions`

**Deliverable**: Clean UX. All commands work. Widget shows live team status.

---

### Phase 6: Integration with `pi-file-permissions`

**Goal**: Ensure persona-based agents work seamlessly with file permission boundaries.

This phase is about **documentation and convention**, not code in this extension:

1. Document that each agent's workspace should have both `persona.yaml` (identity) and `file-permissions.yaml` (boundaries)
2. Optionally: MAMORU could read `file-permissions.yaml` domains and include a summary in the `agent_join` broadcast, so teammates know what files each agent can access. (Nice-to-have, not required for v1.)

**Deliverable**: Documentation + optional cross-extension awareness.

---

## Dependency Changes

```jsonc
// package.json updates
{
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "yaml": "^2.7.0"           // for persona.yaml parsing
  }
}
```

No other new dependencies needed. `@sinclair/typebox` is already a peer dep.

---

## Migration Strategy

This is a **pre-release** extension. No backward compatibility with the current schema is needed.

- Phase 1 introduces a new `initSchema()` that creates the new tables
- Old `.db` files won't work — users should delete `~/.pi/pi-teammate/` (formerly `~/.pi/pi-agent-talk/`) and recreate channels
- Add a version marker to the DB (e.g., `PRAGMA user_version = 2`) so future migrations can detect schema version

---

## Testing Strategy

Each phase should be testable independently:

| Phase | How to Test |
|-------|-------------|
| 1 — Foundation | `/team-create` + `/team-join` work, DB has correct schema, persona loads |
| 2 — MAMORU | Two agents on same channel: ping/pong works, task_req auto-acks, status changes visible in DB |
| 3 — Roster | Agent join → other agent's `delegate_task` tool description updates. Agent leave → removed. |
| 4 — Task Lifecycle | Full flow: delegate_task → task_ack → LLM works → task_done. Timeout fires after 20min (test with short timeout). |
| 5 — Commands + UX | All slash commands work, widget displays correctly. |
| 6 — File Permissions | Agent with `file-permissions.yaml` is correctly restricted while doing delegated tasks. |

**Manual testing setup**: Open 2-3 terminals, each running `pi` with a different `persona.yaml` in different directories, all joined to the same channel.

---

## Estimated Effort

| Phase | Scope | Estimate |
|-------|-------|----------|
| 1 — Foundation | Types, schema, DB layer, persona loader | Small |
| 2 — MAMORU Core | Poll loop, event router, auto-responses, status machine, LLM forwarding | **Large** (core of the system) |
| 3 — Roster + Tool | In-memory roster, dynamic delegate_task, join/leave broadcasts | Medium |
| 4 — Task Lifecycle | Timeout tracking, task state, system prompt injection | Medium |
| 5 — Commands + UX | Slash commands, TUI widget, cleanup | Small |
| 6 — File Permissions | Documentation, optional cross-extension awareness | Small |

**Recommended order**: 1 → 2 → 3 → 4 → 5 → 6 (strictly sequential — each phase depends on the previous).

Phase 2 is the critical path. Get MAMORU right and everything else follows.
