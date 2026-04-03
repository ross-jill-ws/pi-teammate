# Implementation Plan: pi-teammate

> Step-by-step plan to evolve the current `pi-agent-talk` extension into **`pi-teammate`** — the full team messaging system described in [`build-team-message.md`](./build-team-message.md).

## Current State Assessment

### What Exists

| File | Purpose | Status |
|------|---------|--------|
| `extensions/index.ts` | Channel/DB management, agent registration, polling, `send_agent_message` tool, slash commands | **Partially usable** — needs significant refactoring |
| `extensions/talk-prompt-handler.ts` | Listens for `pi_talk_message` events, forwards every message to LLM, auto-replies | **Keep & adapt** — fun chat mode, refactor to work with new framework |
| `package.json` | Package config with `better-sqlite3` dependency | **Minor updates** needed |

### Gap Analysis

| Design Requirement | Current Code | Gap |
|--------------------|-------------|-----|
| Updated schema (`description`, `provider`, `model`, `ref_message_id`, `status` enum, no `type` column) | Old schema with `type` column, `deactive` status, no new fields | **Full schema migration** |
| `persona.yaml` loading | Not implemented | **New** |
| MAMORU guardian loop | Simple polling that emits raw events to `pi.events` | **Major rewrite** — needs event routing, auto-responses, status machine |
| Teammate roster (in-memory) | Not implemented | **New** |
| `delegate_task` tool (dynamic description) | `send_agent_message` tool with static description | **Replace** |
| `send_message` tool (LLM → MAMORU outbound) | Partially exists as `send_agent_message` | **Rewrite** to use new payload schema |
| Event/intent-based payload | Messages use `type` column + raw `content` in payload | **Rewrite** message format |
| Task lifecycle state machine | Not implemented | **New** |
| Task timeout | Not implemented | **New** |
| Heartbeat & liveness | Heartbeat updated on poll, but no ping/pong or inactive detection | **Extend** |
| `agent_join`/`agent_leave` broadcasts | Not implemented | **New** |
| TUI widget with task cards + popup overlay | Simple single-line widget | **Rewrite** — follow `pi-subagent-in-memory` pattern |
| System prompt injection (persona) | `talk-prompt-handler.ts` injects ad-hoc prompt for replies | **Rewrite** — inject persona + task context |
| Test suite | Not implemented | **New** — TDD approach |

---

## File Structure (Target)

```
extensions/
├── index.ts                  # Extension entry point — wires everything together
├── schema.ts                 # SQLite schema init + migration
├── db.ts                     # DB helpers: message CRUD, agent CRUD, cursor ops
├── types.ts                  # Shared TypeScript types (MessageRow, Payload, Roster, etc.)
├── persona.ts                # Load & validate persona.yaml
├── mamoru.ts                 # MAMORU guardian loop (poll, route, auto-respond, status)
├── roster.ts                 # In-memory teammate roster, delegate_task description builder
├── tools/
│   ├── delegate-task.ts      # delegate_task tool definition (dynamic description)
│   └── send-message.ts       # send_message tool (LLM tells MAMORU to send outbound messages)
├── tui/
│   ├── teammate-widget.ts    # Main widget: team roster + task summary cards
│   └── detail-overlay.ts     # Popup overlay for full task/roster details (Ctrl+N)
├── commands.ts               # Slash commands (/team-create, /team-join, /team-leave, etc.)
└── talk-prompt-handler.ts    # Fun mode: 2 agents chatting freely (adapted to new framework)

tests/
├── schema.test.ts            # Schema creation, WAL mode, table structure
├── db.test.ts                # Message CRUD, cursor ops, agent registration
├── persona.test.ts           # persona.yaml loading and validation
├── mamoru.test.ts            # Event routing, auto-responses, status machine
├── roster.test.ts            # Roster updates, delegate_task description building
├── tools.test.ts             # delegate_task and send_message tool execution
├── timeout.test.ts           # Task timeout, timer reset, cancellation flow
├── integration.test.ts       # Multi-agent end-to-end flows (no LLM, mock pi.sendUserMessage)
└── helpers/
    └── mock-pi.ts            # Mock ExtensionAPI, mock pi.sendUserMessage, mock UI context
```

---

## Testing Strategy: TDD

All core logic is tested **without loading the extension into a pi REPL**. The key insight from `create-session.ts` and the pi SDK is that `createAgentSession` works standalone — but for unit testing MAMORU and the DB layer, we don't even need an agent session. We test the logic directly.

### Test Runner

**Bun test** (`bun test`) — already installed, zero config, native TypeScript support.

```jsonc
// package.json additions
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch"
  }
}
```

### Mock Strategy

The extension code is structured so that **MAMORU, roster, DB, and tools are pure logic** that receive dependencies via constructor injection — not by importing pi globals. This makes them testable in isolation.

`tests/helpers/mock-pi.ts` provides:

```ts
// Minimal mock of ExtensionAPI for testing
interface MockPi {
  // Track calls
  sentUserMessages: Array<{ content: string; options?: any }>;
  registeredTools: Map<string, any>;
  emittedEvents: Array<{ name: string; data: any }>;
  widgetUpdates: Array<{ key: string; content: any }>;

  // Mock implementations
  sendUserMessage(content: string, options?: any): void;
  registerTool(tool: any): void;
  events: { emit(name: string, data: any): void; on(name: string, cb: any): void };
}

function createMockPi(): MockPi { ... }

// In-memory SQLite DB for testing (better-sqlite3 supports :memory:)
function createTestDb(): Database { ... }
```

### What Gets Tested (and What Doesn't)

| Layer | Tested | How |
|-------|--------|-----|
| `schema.ts` | ✅ | Create tables in `:memory:` DB, verify structure |
| `db.ts` | ✅ | CRUD ops on `:memory:` DB, cursor advancement |
| `persona.ts` | ✅ | Parse YAML from temp files, validate required fields |
| `mamoru.ts` | ✅ | Inject mock DB + mock pi, verify routing decisions + auto-replies |
| `roster.ts` | ✅ | Pure in-memory logic, verify description generation |
| `tools/*.ts` | ✅ | Execute with mock DB + mock pi, verify DB writes |
| `timeout.ts` | ✅ | Use fake timers (`bun test` supports `jest.useFakeTimers()`) |
| `tui/*.ts` | ❌ | Visual components — test manually in REPL |
| `commands.ts` | ❌ | Slash commands depend on full pi context — test manually |
| `talk-prompt-handler.ts` | ❌ | Fun mode — test manually with 2 agents |
| Integration flows | ✅ | Multi-agent simulation with mock pi + real SQLite |

---

## Implementation Phases

### Phase 0: Test Infrastructure + Types

**Goal**: Set up test harness, define all types, write test specs before any implementation.

#### 0.1 — `extensions/types.ts`

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

// MAMORU config
interface MamoruConfig {
  pollIntervalMs: number;       // default 1000
  taskTimeoutMinutes: number;   // default 20
  pingTimeoutSeconds: number;   // default 20
}
```

#### 0.2 — `tests/helpers/mock-pi.ts`

Create the mock harness.

#### 0.3 — Write all test spec files

Write test files with `describe` blocks and `test` stubs (using `test.todo` for not-yet-implemented). This defines the contract before writing any implementation.

**Deliverable**: All test files exist with clear specs. `bun test` runs and shows N skipped/todo tests.

---

### Phase 1: Foundation (Schema + DB Layer)

**Goal**: New schema, clean DB access layer. TDD — write tests first, then implement.

#### Test Spec: `tests/schema.test.ts`

```ts
describe("schema", () => {
  test("creates all three tables in a new DB");
  test("sets WAL journal mode");
  test("agents table has correct columns and constraints");
  test("messages table has correct columns and foreign keys");
  test("agent_cursors table has composite primary key");
  test("agents status CHECK constraint rejects invalid values");
  test("initSchema is idempotent (CREATE IF NOT EXISTS)");
});
```

#### Test Spec: `tests/db.test.ts`

```ts
describe("agent operations", () => {
  test("registerAgent inserts a new agent");
  test("registerAgent upserts on conflict (same session_id)");
  test("updateAgentStatus changes status");
  test("updateAgentStatus rejects invalid status values");
  test("updateHeartbeat sets last_heartbeat to current time");
  test("getActiveAgents returns non-inactive agents");
  test("getActiveAgents excludes inactive agents");
  test("getAgentBySession returns correct agent");
  test("getAgentBySession returns null for unknown session");
  test("getAgentByName returns correct agent");
});

describe("message operations", () => {
  test("sendMessage inserts a row and returns message_id");
  test("sendMessage validates payload is valid JSON");
  test("sendMessage validates content <= 500 chars");
  test("sendMessage rejects content > 500 chars");
  test("sendMessage allows null to_agent (broadcast)");
  test("sendMessage allows null task_id for non-task messages");
  test("sendMessage sets task_id for task-related messages");
  test("sendMessage allows null ref_message_id");
  test("sendMessage sets ref_message_id for task replies");
  test("task_req sets task_id equal to its own message_id");
});

describe("cursor operations", () => {
  test("initCursor sets last_read_id to 0");
  test("advanceCursor updates last_read_id");
  test("advanceCursor upserts on conflict");
  test("getUnreadMessages returns messages after cursor position");
  test("getUnreadMessages excludes own messages (from_agent != self)");
  test("getUnreadMessages includes broadcasts (to_agent IS NULL)");
  test("getUnreadMessages includes DMs to self");
  test("getUnreadMessages excludes DMs to other agents");
  test("getUnreadMessages returns empty array when fully caught up");
  test("getUnreadMessages with cursor at 0 returns all messages");
});
```

#### Implementation: `extensions/schema.ts`

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
  task_id INTEGER,               -- the originating task_req's message_id (correlation key)
  ref_message_id INTEGER,        -- the specific message this replies to (reply chain)
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_agent) REFERENCES agents(session_id),
  FOREIGN KEY (task_id) REFERENCES messages(message_id),
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

#### Implementation: `extensions/db.ts`

Thin wrapper with prepared statements. All functions take `db: Database` as first argument (dependency injection, no global state).

**Deliverable**: `bun test tests/schema.test.ts tests/db.test.ts` — all green.

---

### Phase 2: Persona Loading

**Goal**: Load `persona.yaml`, validate required fields.

#### Test Spec: `tests/persona.test.ts`

```ts
describe("loadPersona", () => {
  test("loads valid persona.yaml with all fields");
  test("loads persona.yaml with only required fields (name, description)");
  test("returns null when persona.yaml does not exist");
  test("throws on invalid YAML syntax");
  test("throws when name is missing");
  test("throws when description is missing");
  test("trims whitespace from name and description");
  test("provider and model default to null when omitted");
});
```

#### Implementation: `extensions/persona.ts`

- Uses `yaml` package (add to dependencies)
- Reads `{cwd}/persona.yaml`
- Returns `PersonaConfig | null`

**Deliverable**: `bun test tests/persona.test.ts` — all green.

---

### Phase 3: MAMORU Core (Poll Loop + Event Router + Status Machine)

**Goal**: The heart of the system. Replace naive event forwarding with intelligent routing.

#### Test Spec: `tests/mamoru.test.ts`

```ts
describe("MAMORU event routing", () => {
  describe("ping/pong", () => {
    test("auto-replies pong when receiving ping");
    test("pong message has correct from_agent, to_agent, ref_message_id");
    test("updates last_heartbeat on ping");
    test("clears pending ping timer on pong received");
  });

  describe("task_req handling", () => {
    test("auto-sends task_ack when status is available");
    test("task_ack has correct task_id and ref_message_id");
    test("sets status to busy after accepting task_req");
    test("stores activeTaskId with the incoming task_id");
    test("forwards task to LLM via pi.sendUserMessage after auto-ack");
    test("auto-sends task_reject when status is busy");
    test("task_reject includes reason 'Agent is currently busy'");
    test("does not forward to LLM when rejecting");
    test("does not change status when rejecting");
  });

  describe("task_cancel handling", () => {
    test("auto-sends task_cancel_ack");
    test("sets status to available");
    test("clears activeTaskId");
    test("calls pi abort to interrupt LLM");   // ctx.abort()
  });

  describe("broadcast routing", () => {
    test("agent_join intent triggers roster update");
    test("agent_leave intent triggers roster removal");
    test("agent_status_change intent triggers roster update");
    test("other intents are buffered for LLM context");
    test("no auto-reply for any broadcast");
  });

  describe("LLM-forwarded events", () => {
    test("task_clarify is forwarded to LLM");
    test("task_clarify_res is forwarded to LLM");
    test("task_reject is forwarded to LLM");
    test("task_done is forwarded to LLM");
    test("task_fail is forwarded to LLM");
  });

  describe("info_only handling", () => {
    test("buffers message for LLM context");
    test("no auto-reply");
  });

  describe("acknowledgement events", () => {
    test("task_ack is noted but not forwarded to LLM");
    test("task_cancel_ack sets status to available");
  });
});

describe("MAMORU outbound handling", () => {
  test("task_done sets status to available and clears activeTaskId");
  test("task_fail sets status to available and clears activeTaskId");
  test("task_update keeps status as busy");
  test("task_clarify keeps status as busy");
  test("broadcasts agent_status_change when status changes");
});

describe("MAMORU forwardToLlm", () => {
  test("calls pi.sendUserMessage with structured message content");
  test("includes from_agent name in the forwarded message");
  test("includes event type in the forwarded message");
  test("includes task_id and ref_message_id in the forwarded message");
  test("includes detail file path when present");

  describe("delivery", () => {
    test("new task_req (task_id == message_id) never reaches forwardToLlm");
    test("all other messages are delivered as steer");
  });
});

describe("MAMORU poll loop", () => {
  test("polls at configured interval");
  test("updates heartbeat on every poll cycle");
  test("advances cursor after processing messages");
  test("processes multiple messages in order");
  test("handles empty poll (no new messages) gracefully");
});

describe("MAMORU lifecycle", () => {
  test("start() begins polling and registers agent");
  test("stop() clears timer and marks agent inactive");
  test("stop() broadcasts agent_leave");
  test("start() broadcasts agent_join with name and description");
});
```

#### Implementation: `extensions/mamoru.ts`

MAMORU is a class that receives all dependencies via constructor:

```ts
class Mamoru {
  constructor(config: {
    db: Database;
    sessionId: string;
    channel: string;
    persona: PersonaConfig;
    pi: ExtensionAPI;           // for sendUserMessage, registerTool
    ctx: ExtensionContext;      // for abort(), isIdle()
    roster: Roster;
    config: MamoruConfig;
  })

  // Task tracking state
  private activeTaskId: number | null;              // task_id of the task this agent is working on
  private outboundTasks: Map<number, OutboundTask>; // tasks this agent has delegated (for timeout)
}
```

**Key implementation detail — `forwardToLlm` and delivery routing**:

New `task_req` messages (`task_id == message_id`) are auto-handled by MAMORU and never reach `forwardToLlm`. Everything else is always `steer` — if it passed MAMORU's auto-handling, it's relevant to the LLM right now.

```ts
private forwardToLlm(msg: MessageRow, payload: MessagePayload): void {
  const fromName = this.getAgentName(msg.from_agent);
  const structured = [
    `[TEAM MESSAGE from "${fromName}" | event: ${payload.event} | task: #${msg.task_id ?? "none"} | ref: #${msg.ref_message_id ?? "none"}]`,
    payload.content,
    payload.detail ? `Detail file: ${payload.detail}` : null,
  ].filter(Boolean).join("\n");

  this.pi.sendUserMessage(structured, { deliverAs: "steer" });
}
```

**Deliverable**: `bun test tests/mamoru.test.ts` — all green. MAMORU routes all events correctly.

---

### Phase 4: Roster + Tools

**Goal**: Dynamic teammate discovery, `delegate_task` and `send_message` tools.

#### Test Spec: `tests/roster.test.ts`

```ts
describe("Roster", () => {
  test("initFromDb populates roster from agents table");
  test("initFromDb excludes self from roster");
  test("update adds a new entry");
  test("update overwrites existing entry for same session_id");
  test("remove deletes entry by session_id");
  test("markInactive sets status to inactive");
  test("getAll returns all entries");
  test("getAvailable returns only available entries");

  describe("buildToolDescription", () => {
    test("lists all teammates with name, session_id, status, description");
    test("excludes self from listing");
    test("shows 'No teammates are currently online' when roster is empty");
    test("marks busy agents as busy");
    test("marks inactive agents as inactive");
    test("updates description when roster changes");
  });
});
```

#### Test Spec: `tests/tools.test.ts`

```ts
describe("delegate_task tool", () => {
  test("inserts task_req message into DB");
  test("sets from_agent to own session_id");
  test("sets to_agent to target session_id");
  test("sets task_id equal to the new message_id (self-referencing)");
  test("sets ref_message_id to NULL for new task");
  test("payload has event=task_req, need_reply=true");
  test("returns message_id (= task_id) in result for correlation");
  test("rejects if target agent not in roster");
  test("rejects if task content exceeds 500 chars");
  test("sets intent from optional intent parameter");
  test("sets detail from optional detail parameter");
});

describe("send_message tool", () => {
  test("inserts message with specified event type into DB");
  test("validates event is a known MessageEvent");
  test("sets task_id from parameter for task-related events");
  test("sets ref_message_id for task-related events");
  test("requires task_id for task_done, task_fail, task_update, task_clarify");
  test("requires ref_message_id for task_done, task_fail, task_update");
  test("MAMORU intercepts outbound task_done and sets status to available");
  test("MAMORU intercepts outbound task_fail and sets status to available");
  test("MAMORU does not change status for task_update");
  test("allows broadcast (to_agent omitted, to_agent=null)");
  test("validates content <= 500 chars");
});
```

#### Implementation: `extensions/roster.ts`

Pure in-memory Map with description builder.

#### Implementation: `extensions/tools/delegate-task.ts`

```ts
parameters: Type.Object({
  to: Type.String({ description: "session_id of the target agent" }),
  task: Type.String({ description: "Task description (max 500 chars)" }),
  detail: Type.Optional(Type.String({ description: "Absolute file path with full task spec" })),
  intent: Type.Optional(Type.String({ description: "Freeform task type hint, e.g. 'code_review'" }))
})
```

The tool's `description` is **dynamically rewritten** by MAMORU whenever roster changes, via `pi.registerTool()` re-registration.

#### Implementation: `extensions/tools/send-message.ts`

This is the general-purpose outbound tool for the LLM. Used for:
- `task_done` / `task_fail` (completing a task)
- `task_update` (progress report)
- `task_clarify` (asking requester for info)
- `broadcast` / `info_only` (announcements)
- Any other event the LLM needs to send

```ts
parameters: Type.Object({
  to: Type.Optional(Type.String({ description: "session_id of recipient. Omit for broadcast." })),
  event: Type.String({ description: "Message event type (task_done, task_update, broadcast, etc.)" }),
  task_id: Type.Optional(Type.Number({ description: "The originating task_req's message_id. Required for all task-related events." })),
  ref_message_id: Type.Optional(Type.Number({ description: "The specific message this replies to. Usually same as task_id." })),
  content: Type.String({ description: "Message content (max 500 chars)" }),
  detail: Type.Optional(Type.String({ description: "Absolute file path with detailed content" })),
  intent: Type.Optional(Type.String({ description: "Freeform intent hint" })),
})
```

MAMORU hooks the `tool_result` event for `send_message` to manage status transitions:
- If event is `task_done` or `task_fail` → set status → `available`, clear `activeTaskId`, broadcast `agent_status_change`
- If event is `task_update` or `task_clarify` → no status change

**Why two tools?** `delegate_task` = **start** a task (outbound `task_req`). `send_message` = **everything else** (replies, updates, broadcasts). The LLM sees `delegate_task` with a live roster in the description — it's optimized for "who should I assign this to?" `send_message` is for ongoing communication once a task is in flight.

**Deliverable**: `bun test tests/roster.test.ts tests/tools.test.ts` — all green.

---

### Phase 5: Task Timeout

**Goal**: Configurable timeout with reset on worker events.

#### Test Spec: `tests/timeout.test.ts`

```ts
describe("task timeout", () => {
  // Use bun's fake timer support
  test("starts timeout timer when task_req is sent via delegate_task");
  test("timer duration matches config.taskTimeoutMinutes");
  test("timer resets on task_update from worker");
  test("timer resets on task_clarify from worker");
  test("timer resets on any message with matching ref_message_id");
  test("sends task_cancel with intent=task_timeout when timer expires");
  test("waits pingTimeoutSeconds for task_cancel_ack after timeout");
  test("marks worker inactive if no task_cancel_ack received");
  test("forwards timeout notification to LLM for reassignment");
  test("clears timeout timer when task_done received");
  test("clears timeout timer when task_fail received");
  test("clears timeout timer when task_cancel_ack received");
  test("handles multiple outbound tasks with independent timers");
});
```

#### Implementation

Timeout logic lives in MAMORU as `outboundTasks` tracking (requester side):

```ts
private outboundTasks: Map<number, {  // keyed by task_id
  workerSessionId: string;
  sentAt: number;
  lastEventAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}>;
```

**Deliverable**: `bun test tests/timeout.test.ts` — all green.

---

### Phase 6: TUI Widget + Popup Overlay

**Goal**: Rich terminal UI showing team status and task tracking. Pattern follows `pi-subagent-in-memory`.

#### No automated tests — manually tested in REPL.

#### 6.1 — `extensions/tui/teammate-widget.ts`

The main widget renders **two cards** side by side:

```
┌─ team: project-alpha ──── #1 ┐  ┌─ tasks ──────────────── #2 ┐
│ ● You (Code Reviewer)        │  │ → task #42: Review PR #123  │
│   available                  │  │   assigned to: Developer 1   │
│ ○ Developer 1 — busy         │  │   status: busy  ⏱ 3m 42s    │
│ ○ Developer 2 — available    │  │ ✅ task #38: Fix login bug   │
│ ○ Tester — available         │  │   done by: Developer 2       │
│ show more: C-S-r              │  │ show more: C-S-t              │
└──────────────────────────────┘  └──────────────────────────────┘
```

**Card 1 — Team Roster** (widget key: `teammate-roster`):
- Title: `team: {channelName}`
- Badge: `#1`
- Shows self (highlighted) + up to 4 teammates with status
- If >5 agents: footer shows "show more: C-S-r" (Ctrl+Shift+R for roster)
- Each entry: `● name — status` (● for available, ○ for busy, ✖ for inactive)

**Card 2 — Task Tracker** (widget key: `teammate-tasks`):
- Title: `tasks`
- Badge: `#2`
- Shows up to 4 active/recent tasks with:
  - Task ref ID + first ~30 chars of content
  - Who it's assigned to
  - Status (busy/done/failed) + **elapsed timer** (live, updated every 500ms)
- If >4 tasks: footer shows "show more: C-S-t" (Ctrl+Shift+T for tasks)

**Implementation pattern**: Follow `SubagentCardsWidget` from `pi-subagent-in-memory`:
- Component class with `render(width): string[]` and `dispose()`
- Use `renderCard()` helper from a shared `tui-draw.ts`
- Animation timer (500ms) for live elapsed counters
- `requestRender()` on TUI to trigger redraws

Both cards are rendered by a single widget component registered via:
```ts
ctx.ui.setWidget("teammate", (tui, theme) => new TeammateWidget(tui, theme, mamoru), { placement: "aboveEditor" });
```

#### 6.2 — `extensions/tui/detail-overlay.ts`

Popup overlay triggered by **Ctrl+Shift+R** (roster) and **Ctrl+Shift+T** (tasks). Pattern follows `SubagentDetailOverlay`:

```ts
// Register shortcuts
pi.registerShortcut(Key.ctrlShift("r"), {
  description: "Show full team roster",
  handler: async (ctx) => {
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new RosterDetailOverlay(mamoru.getRoster(), theme, done),
      { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
    );
  }
});

pi.registerShortcut(Key.ctrlShift("t"), {
  description: "Show full task list",
  handler: async (ctx) => {
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new TaskDetailOverlay(mamoru.getOutboundTasks(), theme, done),
      { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } }
    );
  }
});
```

**Roster overlay** shows all agents with full descriptions.
**Task overlay** shows all tasks (active + completed) with full content, detail paths, timestamps, and elapsed timers.

Both implement `Focusable` interface and close on Escape/Enter/same-shortcut.

**Deliverable**: Widget renders live in REPL. Ctrl+Shift+R / Ctrl+Shift+T popups work.

---

### Phase 7: Commands + Wiring

**Goal**: Clean up slash commands, wire everything together in `index.ts`.

#### 7.1 — `extensions/commands.ts`

**Team commands:**

| Command | Description |
|---------|-------------|
| `/team-create [name]` | Create a new channel DB |
| `/team-join <channel> [agentName]` | Join a channel, start MAMORU, broadcast `agent_join` |
| `/team-leave` | Broadcast `agent_leave`, stop MAMORU, mark agent inactive |
| `/team-send <to> <message>` | Send a manual message (debugging/testing) |
| `/team-status` | Show current status, channel, active task |
| `/team-roster` | Print all agents on the channel with status |
| `/team-history [n]` | Show last N messages (default 20) |

**Task commands:**

| Command | Description |
|---------|-------------|
| `/task-status` | Show active task (if working on one) + all outbound delegated tasks with status, assignee, elapsed time |
| `/task-list` | List all tasks on the channel (all agents) with task_id, from, to, status, timestamps |
| `/task-cancel [task_id]` | Manually cancel an outbound task by task_id. Sends `task_cancel` message. |
| `/task-history <task_id>` | Show full message history for a specific task (all messages with matching task_id) |

#### 7.2 — CLI Flags for Programmatic Startup

Two CLI flags allow users to start agents programmatically without manual `/team-*` commands — ideal for scripting multiple teammates in iTerm tabs or tmux panes:

```bash
# Start a code reviewer agent on the "project-alpha" channel
pi --team-channel project-alpha --agent-name "Code Reviewer"

# Start a tester agent on the same channel
pi --team-channel project-alpha --agent-name "Tester"
```

**Registration:**

```ts
pi.registerFlag("team-channel", {
  description: "Auto-join a team channel on startup (requires --agent-name)",
  type: "string",
});

pi.registerFlag("agent-name", {
  description: "Agent name for team registration (requires --team-channel)",
  type: "string",
});
```

**Auto-bootstrap on `session_start`:**

```ts
pi.on("session_start", async (_event, ctx) => {
  const channel = pi.getFlag("team-channel") as string | undefined;
  const agentName = pi.getFlag("agent-name") as string | undefined;

  if (!channel && !agentName) return;  // no flags, normal startup

  if (!channel || !agentName) {
    ctx.ui.notify("--team-channel and --agent-name must be used together", "error");
    return;
  }

  // 1. Create channel DB if it doesn't exist
  const dbPath = getDbPath(channel);
  if (existsSync(dbPath)) {
    console.log(`[teammate] Channel "${channel}" already exists, skipping creation`);
  } else {
    mkdirSync(BASE_DIR, { recursive: true });
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
    console.log(`[teammate] Created channel: ${channel}`);
  }

  // 2. Auto-register and start MAMORU
  const persona = loadPersona(ctx.cwd);
  mamoru = new Mamoru({
    db: openDb(channel),
    sessionId: ctx.sessionManager.getSessionId(),
    channel,
    agentName,
    persona,
    pi,
    ctx,
    roster: new Roster(),
    config: defaultMamoruConfig,
  });
  mamoru.start();

  console.log(`[teammate] Joined "${channel}" as "${agentName}"`);
});
```

This means a multi-agent team can be launched with a simple shell script:

```bash
#!/bin/bash
# launch-team.sh — start 3 agents in tmux panes
tmux new-session -d -s team

tmux send-keys "cd ~/agents/planner && pi --team-channel project-alpha --agent-name Planner" Enter
tmux split-window -h
tmux send-keys "cd ~/agents/developer && pi --team-channel project-alpha --agent-name Developer" Enter
tmux split-window -v
tmux send-keys "cd ~/agents/reviewer && pi --team-channel project-alpha --agent-name Reviewer" Enter

tmux attach -t team
```

Each agent directory has its own `persona.yaml` and `file-permissions.yaml`.

#### 7.3 — `extensions/index.ts`

The entry point wires everything:

```ts
export default function(pi: ExtensionAPI) {
  let mamoru: Mamoru | null = null;

  // Load persona on session start
  pi.on("session_start", async (_event, ctx) => {
    const persona = loadPersona(ctx.cwd);
    if (persona) {
      console.log(`[teammate] Loaded persona: ${persona.name}`);
    }
  });

  // Inject persona + task context into system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    if (!mamoru) return;
    return mamoru.buildSystemPromptAdditions(event.systemPrompt);
  });

  // Register commands
  registerCommands(pi, () => mamoru);

  // Register shortcuts for overlay popups
  registerShortcuts(pi, () => mamoru);

  // Cleanup
  pi.on("session_shutdown", async () => {
    mamoru?.stop();
  });
}
```

#### 7.4 — `extensions/talk-prompt-handler.ts` (adapted)

The fun chat mode is refactored to work with the new framework:

- Listens for `pi_talk_message` custom events (emitted by MAMORU when forwarding to LLM is needed)
- Instead of blindly forwarding every message, it now **only activates when MAMORU is not running** (standalone chat mode vs. team mode)
- When MAMORU is active, it handles LLM forwarding — `talk-prompt-handler` stays out of the way
- When MAMORU is NOT active (e.g., agent registered on channel but not in team mode), `talk-prompt-handler` provides the simple 2-agent chat experience

```ts
export default function(pi: ExtensionAPI) {
  let mamoruActive = false;

  // MAMORU sets this flag when it starts/stops
  pi.events.on("mamoru_started", () => { mamoruActive = true; });
  pi.events.on("mamoru_stopped", () => { mamoruActive = false; });

  pi.events.on("pi_talk_message", (data: unknown) => {
    if (mamoruActive) return; // MAMORU handles it

    // Original fun chat behavior: parse message, inject as user prompt, auto-reply
    const row = data as TalkMessageEvent;
    // ... (existing logic, adapted to new payload schema)
  });
}
```

**Deliverable**: Full working system. All commands, widgets, tools, MAMORU wired together.

---

### Phase 8: Integration Tests

**Goal**: End-to-end multi-agent flows without a real LLM.

#### Test Spec: `tests/integration.test.ts`

```ts
describe("multi-agent integration", () => {
  // Each test creates 2-3 mock agents sharing one in-memory DB

  describe("agent discovery", () => {
    test("agent A joins, agent B joins, both see each other in roster");
    test("agent C joins late and sees A and B in roster");
    test("agent A leaves, B and C see A removed from roster");
  });

  describe("task delegation flow", () => {
    test("A sends task_req to B, B auto-acks, B's status becomes busy");
    test("task_ack has matching task_id");
    test("B sends task_done, B's status becomes available, A receives result");
    test("A sends task_req to B (busy), B auto-rejects");
  });

  describe("task clarification flow", () => {
    test("A sends task_req, B sends task_clarify, A sends task_clarify_res, B sends task_done");
    test("all messages in the flow share the same task_id");
    test("task_clarify_res ref_message_id points to the task_clarify message");
  });

  describe("sub-delegation flow", () => {
    test("B delegates #78 to C while busy on #42 — #78 has task_id=78 (task_id == message_id)");
    test("C's task_done for #78 is delivered to B as steer");
    test("B processes C's result and completes #42");
  });

  describe("task cancellation flow", () => {
    test("A sends task_cancel, B auto-acks, B status becomes available");
    test("B's activeTaskId is cleared");
  });

  describe("timeout flow", () => {
    test("A sends task_req, no response for taskTimeoutMinutes, A sends task_cancel");
    test("task_update from B resets the timeout timer");
  });

  describe("heartbeat/liveness", () => {
    test("A pings B, B auto-pongs");
    test("A pings C (no response), A marks C inactive after pingTimeoutSeconds");
  });

  describe("CLI flag auto-bootstrap", () => {
    test("--team-channel + --agent-name creates DB if not exists and auto-joins");
    test("--team-channel + --agent-name skips DB creation if already exists");
    test("--team-channel without --agent-name shows error");
    test("--agent-name without --team-channel shows error");
    test("auto-bootstrapped agent broadcasts agent_join");
    test("auto-bootstrapped agent appears in other agents' rosters");
  });
});
```

These tests simulate multiple MAMORU instances sharing one `:memory:` SQLite DB, with mock `pi.sendUserMessage` to capture LLM-forwarded messages.

**Deliverable**: `bun test` — all tests green.

---

### Phase 9: Integration with `pi-file-permissions`

**Goal**: Documentation and convention. No code changes.

- Document that each agent's workspace should have both `persona.yaml` and `file-permissions.yaml`
- Optional: MAMORU reads `file-permissions.yaml` domains and includes a summary in the `agent_join` broadcast

**Deliverable**: Documentation.

---

## Dependency Changes

```jsonc
// package.json updates
{
  "name": "pi-teammate",
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "yaml": "^2.7.0"
  },
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch"
  }
}
```

---

## Migration Strategy

This is a **pre-release** extension. No backward compatibility with the current schema is needed.

- Phase 1 introduces a new `initSchema()` that creates the new tables
- Old `.db` files won't work — users should delete `~/.pi/pi-teammate/` (formerly `~/.pi/pi-agent-talk/`) and recreate channels
- Add a version marker to the DB (e.g., `PRAGMA user_version = 2`) so future migrations can detect schema version

---

## Phase Summary

| Phase | What | Size | Tests |
|-------|------|------|-------|
| **0 — Test Infra + Types** | Types, mock harness, test spec stubs | Small | Spec only |
| **1 — Foundation** | Schema, DB layer | Small | `schema.test.ts`, `db.test.ts` |
| **2 — Persona** | persona.yaml loader | Small | `persona.test.ts` |
| **3 — MAMORU Core** | Poll loop, event router, auto-responses, status machine, LLM forwarding | **Large** | `mamoru.test.ts` |
| **4 — Roster + Tools** | In-memory roster, `delegate_task`, `send_message` | Medium | `roster.test.ts`, `tools.test.ts` |
| **5 — Timeout** | Task timeout tracking, timer reset, cancellation | Medium | `timeout.test.ts` |
| **6 — TUI Widget** | Cards widget, popup overlays | Medium | Manual |
| **7 — Commands + Wiring** | Slash commands, `index.ts` wiring, `talk-prompt-handler` adaptation | Medium | Manual |
| **8 — Integration Tests** | Multi-agent end-to-end flows | Medium | `integration.test.ts` |
| **9 — File Permissions** | Documentation | Small | N/A |

**Recommended order**: Strictly sequential. Each phase depends on the previous. Phase 3 (MAMORU) is the critical path — get it right and everything else follows.

---

### Phase 10: `/mamoru` Event Log Overlay

**Goal**: A live, scrollable overlay showing all events MAMORU has handled, with color-coded direction/type and LLM forwarding indicators.

#### 10.1 — Event Log in MAMORU

MAMORU records every event it handles (both received and sent) into an in-memory `eventLog` array:

```ts
export interface MamoruEventLog {
  timestamp: number;
  direction: "recv" | "sent";
  event: string;              // e.g., "task_req", "task_ack", "ping"
  otherParty: string;         // agent name of the other side
  taskId: number | null;
  content: string | null;
  forwardedToLlm: boolean;    // true if this event was steered to the LLM
}
```

Every `processMessage` branch logs a `recv` entry. Every `autoReply` logs a `sent` entry. The `delegate_task` and `send_message` tools call `mamoru.logOutbound()` to log their sent events.

#### 10.2 — `/mamoru` Command + Ctrl+Shift+M Shortcut

Registered in `commands.ts`. Opens the overlay:

```ts
pi.registerCommand("mamoru", {
  description: "Show MAMORU event log overlay",
  handler: async (_args, ctx) => {
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new MamoruOverlay(() => mamoru.getEventLog(), theme, done, tui),
      {
        overlay: true,
        overlayOptions: { anchor: "top-right", width: "34%", maxHeight: "100%", margin: 0 },
      }
    );
  }
});
```

Also registered as **Ctrl+Shift+M** shortcut for quick access. Uses `nonCapturing: true` so the user can type in the editor while the overlay is visible. Ctrl+Shift+M cycles: show (non-capturing) → focus (scrollable) → close. Esc from focused state unfocuses back to editor.

**Shortcut convention**: pi-teammate uses `Ctrl+Shift+<letter>` shortcuts to avoid conflicts with `pi-subagent-in-memory` which uses `Ctrl+<number>`. Ctrl+Alt+N doesn't work reliably across terminals (iTerm/macOS don't send the expected escape sequences).

#### 10.3 — `extensions/tui/mamoru-overlay.ts`

A `Focusable` overlay component anchored to the right 1/3 of the terminal, full height.

**Features**:
- **Color-coded events**:
  - Received events: blue/cyan family (◀ RECV)
  - Sent events: color by type (▶ SENT)
    - `task_done`, `task_ack` → green
    - `task_fail`, `task_reject` → red
    - `task_cancel` → orange
    - `task_update`, `task_cancel_ack` → yellow
    - `task_clarify`, `task_clarify_res` → cyan
    - `pong` → dim
    - `broadcast` → magenta
- **Per-entry display**: direction arrow, event name, timestamp, other party, task ID, content preview, LLM forwarding indicator (⚡ → LLM)
- **Vertical scrolling**: ↑/↓, j/k, PageUp/PageDown, Home/End (g/G)
- **Auto-scroll**: Automatically scrolls to bottom on new events unless user has manually scrolled up. Scrolling back to bottom re-enables auto-scroll.
- **Live refresh**: 500ms timer checks for new events and triggers re-render
- **Scrollbar**: Visual scroll position indicator on the right edge when content exceeds viewport
- **Close**: Esc key

**No automated tests** — tested manually in REPL.
