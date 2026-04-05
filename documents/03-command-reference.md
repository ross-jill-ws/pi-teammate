# Command Reference

Complete manual for `pi-teammate` CLI flags, slash commands, and TUI overlay shortcuts.

---

## CLI Flags

These flags are passed when launching a `pi` session from the terminal.

### `--team-channel <name>`

Join a team channel on startup. Must be used together with `--agent-name`.

The channel name maps to a directory under `~/.pi/pi-teammate/<name>/` containing the shared SQLite database.

```bash
pi --team-channel forex-rt --agent-name developer
```

### `--agent-name <name>`

Set the agent's display name for team registration. Must be used together with `--team-channel`.

If a `persona.yaml` exists in the working directory and `--agent-name` is omitted, the `name` field from `persona.yaml` is used instead.

```bash
pi --team-channel forex-rt --agent-name designer
```

### `--team-new`

Delete the existing channel database and start clean. Use with `--team-channel`. Only the **first** agent on a new team should use this flag.

```bash
# Creates a fresh team — any previous data for this channel is deleted
pi --team-channel forex-rt --agent-name designer --team-new
```

### Combined Example

```bash
# First agent: create the team
pi --team-channel my-project --agent-name designer --team-new

# Second agent: join the existing team
pi --team-channel my-project --agent-name developer

# Third agent: join later
pi --team-channel my-project --agent-name tester
```

---

## Slash Commands

These commands are available inside the `pi` REPL after the `pi-teammate` extension is loaded. Type them at the prompt.

### Team Management

#### `/team-create [channelName]`

Create (or recreate) a team channel database. If the channel already exists, its data is deleted and a fresh database is created. Equivalent to the `--team-new` flag.

If `channelName` is omitted, the current session ID is used as the channel name.

```
/team-create forex-rt
```

#### `/team-join <channel> [agentName]`

Join an existing team channel and start MAMORU polling. A broadcast message is sent to all existing teammates announcing your arrival.

If `agentName` is omitted, the current session ID is used. If you're already on a team, you must `/team-leave` first.

```
/team-join forex-rt developer
```

#### `/team-leave`

Leave the current team channel. Stops MAMORU polling and broadcasts a leave notification to all remaining teammates.

```
/team-leave
```

#### `/team-status`

Show the current team connection status: channel name, agent name, session ID, availability status, active task (if any), and number of outbound tasks.

```
/team-status
```

#### `/team-roster`

Show all agents currently in the roster with their session IDs, status (`available`/`busy`/`inactive`), and descriptions.

```
/team-roster
```

#### `/team-history [n]`

Show the last N messages on the channel. Defaults to 20 if `n` is omitted. Messages are displayed oldest-first with timestamps, sender, recipient, event type, and content.

```
/team-history       # last 20 messages
/team-history 50    # last 50 messages
```

#### `/team-send <to_session_id> <message>`

Send a manual message for debugging purposes. Sends a `broadcast` event to the specified session ID with the given message content.

```
/team-send abc123 "hello from debugging"
```

### Task Management

#### `/task-status`

Show the active inbound task (the task this agent is currently working on) and all outbound tasks (tasks this agent has delegated to others) with elapsed times.

```
/task-status
```

#### `/task-list`

List all `task_req` messages that have been created on the channel, showing task IDs, timestamps, sender, recipient, and content summary.

```
/task-list
```

#### `/task-history <task_id>`

Show all messages belonging to a specific task — the full lifecycle from `task_req` through `task_ack`, any clarifications, updates, and the final `task_done`/`task_fail`.

```
/task-history 42
```

#### `/task-cancel <task_id>`

Cancel an outbound task (a task you sent to another agent). Sends a `task_cancel` event to the worker agent.

```
/task-cancel 42
```

### Persona

#### `/persona-template`

Generate a `persona.yaml` template file in the current working directory. The `name` is derived from the directory name, and `provider`/`model` are populated from the current session's configuration.

Will not overwrite an existing `persona.yaml`.

```
/persona-template
```

### Overlays

#### `/mamoru`

Toggle the MAMORU event log overlay. Same as pressing `Ctrl-t m`. See TUI Overlay Shortcuts below.

```
/mamoru
```

---

## TUI Overlay Shortcuts

The TUI provides three overlay panels for monitoring team activity in real time. All overlays are **non-capturing** — you can keep typing in the input box while they're visible.

### Prefix Key: `Ctrl-t`

Press `Ctrl-t` to enter prefix mode, then press one of the following keys within 1.5 seconds:

| Key | Overlay | Description |
|-----|---------|-------------|
| `m` | **MAMORU Log** | Live feed of all MAMORU events — messages sent, received, auto-handled, and forwarded to the LLM. Useful for understanding the message flow. |
| `r` | **Roster** | Shows all teammates with their names, session IDs, status (`available`/`busy`/`inactive`), and role descriptions. Updates in real time as agents join, leave, or change status. |
| `t` | **Task Tracker** | Shows the active inbound task and all outbound tasks with requester/worker names, task IDs, and elapsed times. |

### Overlay Controls

- **Toggle focus:** Press the same `Ctrl-t` + key combination again to toggle focus on the overlay (e.g. for scrolling).
- **Close:** Press `Esc` to close any active overlay, regardless of focus state.
- **Status bar:** While in prefix mode, the status bar shows: `Ctrl+T ▸ (m)amoru  (r)oster  (t)asks`

### Example Workflow

1. Press `Ctrl-t`, then `r` — the roster overlay appears, showing all teammates and their status.
2. Press `Ctrl-t`, then `m` — the MAMORU log overlay appears alongside the roster.
3. Type a prompt — the overlays stay visible while you work.
4. Press `Esc` — all overlays close.

---

## MAMORU: The Core of the Messaging System

MAMORU is not just a helper — it **is** the messaging system. Every message in `pi-teammate` flows through MAMORU, in both directions:

```
                  ┌────────────────────────────────────────┐
                  │             Agent Process              │
                  │                                        │
   SQLite DB      │    ┌──────────┐       ┌────────────┐   │
   (messages      │    │          │ steer │            │   │
    table)  ─────read──▶ MAMORU  ├──────▶│    LLM     │   │
                  │    │          │       │            │   │
            ◀──write───│ (guard)  │◀──────│  session   │   │
                  │    │          │ tool  │            │   │
                  │    └──────────┘ call  └────────────┘   │
                  │                                        │
                  └────────────────────────────────────────┘
```

**Inbound path (SQLite → MAMORU → LLM):** MAMORU polls the SQLite database every second. For each new message, it decides: handle automatically (ack, reject, roster update) or forward to the LLM via `steer`. The LLM never reads the database directly.

**Outbound path (LLM → MAMORU → SQLite):** When the LLM wants to talk to another agent — delegate a task, send a result, ask for clarification, broadcast an announcement — it calls the `send_message` tool. That tool call goes through MAMORU, which writes the message to SQLite, manages status transitions (e.g. `busy` → `available` on `task_done`), and tracks outbound tasks for timeout.

The LLM has **no other way** to communicate with teammates. There is no direct database access, no side channel, no API call. Everything goes through MAMORU, which is why it's called the guardian — it protects the LLM from noise on the inbound side and enforces protocol on the outbound side.

---

## The `send_message` Tool

`send_message` is the **single tool** that the LLM uses for all teammate communication. It is registered automatically when `pi-teammate` is loaded, and it is unlike any other tool because **its description changes on the fly**.

### Dynamic Tool Description

Most tools have a static description that never changes. `send_message` is different — MAMORU rewrites its description every time the team roster changes. This is how the LLM knows who's on the team, who's available, and who to send tasks to.

Here's what the LLM sees when it considers calling `send_message`:

**When no teammates are online:**

```
send_message: Send a message to a teammate or broadcast to the team.
Use event 'task_req' to request work or ask a question (expects a response).
Use task_done/task_fail/task_update/task_clarify for task lifecycle.
Use broadcast/info_only for announcements (no response expected).
No teammates are currently online.
```

**After a developer and tester join:**

```
send_message: Send a message to a teammate or broadcast to the team.
Use event 'task_req' to request work or ask a question (expects a response).
Use task_done/task_fail/task_update/task_clarify for task lifecycle.
Use broadcast/info_only for announcements (no response expected).

Available teammates:
  - "Developer" (session: sess-abc) — available — Fullstack developer specialized in React Router v7...
  - "Tester" (session: sess-def) — available — Code reviewer and functional tester...

To request work or ask a question, use event 'task_req' with a 'to' recipient.
Pick an 'available' agent whose description matches the request.
If no suitable agent is available, report that to the user.
```

**After the developer starts working on a task (status → busy):**

```
Available teammates:
  - "Developer" (session: sess-abc) — busy — Fullstack developer specialized in React Router v7...
  - "Tester" (session: sess-def) — available — Code reviewer and functional tester...
```

**After the developer disconnects (status → inactive):**

```
Available teammates:
  - "Tester" (session: sess-def) — available — Code reviewer and functional tester...
```

The inactive developer is removed from the roster entirely.

### What Triggers a Description Rewrite

The description is rewritten by MAMORU via the `teammate_roster_changed` event whenever:

| Trigger | What changed |
|---------|-------------|
| `broadcast` with intent `agent_join` | New teammate added to roster |
| `broadcast` with intent `agent_leave` | Teammate removed from roster |
| `broadcast` with intent `agent_status_change` | Teammate status updated |
| Stale heartbeat detected | Teammate marked `inactive`, removed from roster |
| Roster status refresh (every poll cycle) | Status synced from DB (e.g. `busy` → `available`) |

Under the hood, `pi.registerTool()` is called again with the updated description, replacing the previous version. The LLM's next turn always sees the current state.

### Concrete Example: Dynamic Description Through a Session

Here's the timeline of what the Designer's LLM sees in the `send_message` tool description as a session progresses:

```
T=0   Designer starts the team (--team-new)
      Tool desc: "...No teammates are currently online."

T=10  Developer joins → broadcast agent_join → MAMORU adds to roster
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — available — Fullstack dev..."

T=20  Tester joins → broadcast agent_join → MAMORU adds to roster
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — available — Fullstack dev...
        - "Tester" (sess-def) — available — Code reviewer..."

T=30  Designer sends task_req to Developer → Developer's MAMORU auto-acks → busy
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — busy — Fullstack dev...
        - "Tester" (sess-def) — available — ..."

T=45  Designer wants to send another task
      LLM sees Developer is "busy", picks Tester instead (or uses blocking=true to wait)

T=90  Developer sends task_done → MAMORU sets status → available
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — available — Fullstack dev...
        - "Tester" (sess-def) — available — ..."

T=120 New teammate joins mid-session: Accessibility Reviewer
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — available — ...
        - "Tester" (sess-def) — available — ...
        - "Accessibility Reviewer" (sess-ghi) — available — ..."

T=180 Tester crashes (no heartbeat) → MAMORU marks inactive → removed
      Tool desc: "...Available teammates:
        - "Developer" (sess-abc) — available — ...
        - "Accessibility Reviewer" (sess-ghi) — available — ..."
```

The LLM never queries a database, never calls an API to list agents, never maintains its own roster state. It just reads the tool description — MAMORU keeps it current.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | no | Session ID of the recipient. Omit for broadcast. |
| `event` | string | yes | Event type: `task_req`, `task_done`, `task_fail`, `task_update`, `task_clarify`, `task_clarify_res`, `broadcast`, `info_only`, etc. |
| `content` | string | yes | Brief summary (max ~20 words). Full details go in `detail`. |
| `detail` | string | no | Absolute file path to a detail markdown file. **Required for `task_req`** — must contain full context, requirements, and absolute paths to any referenced files. Also recommended for `task_done`/`task_fail`. |
| `task_id` | number | no | The originating `task_req`'s message ID. Required for task lifecycle events (`task_done`, `task_fail`, `task_update`, `task_clarify`, `task_clarify_res`). Auto-set for `task_req`. Auto-filled from active task if omitted. |
| `ref_message_id` | number | no | The specific message this replies to. Usually same as `task_id`. |
| `intent` | string | no | Freeform hint (e.g., `code_review`, `write_tests`). |
| `blocking` | boolean | no | For `task_req` only. If `true`, MAMORU auto-retries when rejected (waits for recipient to become available). Default: `false`. |

### Validations

- `task_req` requires a `to` recipient.
- Self-delegation is not allowed.
- The target must be in the current roster.
- Content word count is enforced (configurable via `contentWordLimit` in `persona.yaml`).
- For task replies (`task_done`, `task_fail`, `task_update`, `task_clarify`, `task_clarify_res`), `to` and `task_id` are auto-filled from the active task if omitted.

---

## Example Flows

These examples show the full message flow for common scenarios, including what MAMORU handles automatically and what reaches the LLM. Each arrow represents a message row in the SQLite `messages` table.

### Simple Task Request

A planner asks a code reviewer to review a PR. MAMORU auto-acks and the reviewer's LLM does the work.

```
Agent A (Planner)                         Agent B (Code Reviewer)
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   content: "Reviewer, check PR #123"     │
       │   detail: "/path/to/review-brief.md"     │
       │                                  [MAMORU] │← auto task_ack, status→busy
       │◀──────────────────────── task_ack ───────│
       │   content: "accepted"                     │
       │                                          │  [LLM reads detail file, reviews code]
       │◀──────────────────────── task_update ────│
       │   content: "Reviewer, task status update" │
       │                                          │
       │◀──────────────────────── task_done ──────│
       │   content: "Planner, review complete"     │
       │   detail: "/path/to/review-results.md"   │
       │                                  [MAMORU] │← status→available
```

**What MAMORU auto-handles:** `task_ack` (immediate), status → `busy` on receipt, status → `available` on `task_done`.
**What reaches the LLM:** The `task_req` content + detail file (on B's side), `task_update` and `task_done` (on A's side).

### Task with Clarification

The worker needs more information mid-task. The requester's LLM composes the answer.

```
Agent A (Planner)                         Agent B (Developer)
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   content: "Developer, refactor auth"    │
       │   detail: "/path/to/refactor-spec.md"    │
       │                                  [MAMORU] │← auto task_ack, status→busy
       │◀──────────────────────── task_ack ───────│
       │                                          │
       │◀──────────────────────── task_clarify ───│
       │   content: "Planner, which auth module?" │
       │   (task_id=42, ref_message_id=42)        │
       │                                          │
       │── task_clarify_res ─────────────────────▶│
       │   content: "Developer, the OAuth module" │
       │   (task_id=42, ref_message_id=44)        │  ← replies to the clarify
       │                                          │
       │◀──────────────────────── task_done ──────│
       │                                  [MAMORU] │← status→available
```

**What reaches the LLM:** `task_clarify` is forwarded to A's LLM so it can answer. `task_clarify_res` is forwarded to B's LLM so it can continue.

### Task Rejection (Agent Busy)

When an agent is already busy, MAMORU auto-rejects without interrupting the LLM.

```
Agent A (Planner)                         Agent B (Developer) [status=busy]
       │                                          │
       │── task_req ─────────────────────────────▶│
       │   content: "Developer, write migration"  │
       │                                  [MAMORU] │← auto task_reject (busy)
       │◀──────────────────────── task_reject ────│
       │   content: "busy"                         │
```

**What reaches the LLM:** The `task_reject` is forwarded to A's LLM so it can pick another agent or wait.

**With `blocking: true`:** MAMORU on A's side silently queues the task. When B finishes its current work and becomes `available`, MAMORU auto-retries the `task_req` — the LLM on A is never interrupted.

**With `blocking: false`:** MAMORU on A's side notifies A's LLM that the task was rejected but queued for auto-retry. A can continue other work in the meantime.

### Task Sub-Delegation

A worker delegates part of its task to another agent. Each sub-delegation creates a fresh `task_req` with its own `task_id` — no special chaining logic.

```
Agent A (Planner)          Agent B (Developer)          Agent C (Tester)
       │                          │                            │
       │── task_req ─────────────▶│  (message_id=42, task_id=42)
       │   "Build auth feature"   │                            │
       │                  [MAMORU]│← auto task_ack, busy       │
       │◀──── task_ack ──────────│                             │
       │                          │                            │
       │                          │── task_req ────────────────▶│  (message_id=78, task_id=78)
       │                          │   "Write tests for oauth"  │
       │                          │                     [MAMORU]│← auto task_ack, busy
       │                          │◀──── task_ack ────────────│
       │                          │◀──── task_done ───────────│  (task_id=78, ref=78)
       │                          │                     [MAMORU]│← status→available
       │                          │                            │
       │◀──── task_done ─────────│  (task_id=42, ref=42)       │
       │                  [MAMORU]│← status→available           │
```

C's `task_done` has `task_id=78 ≠ message_id`, so MAMORU knows it's not a new task — it's forwarded to B's LLM via `steer`. No special sub-delegation logic needed.

### Task Cancellation

The requester cancels an in-flight task. MAMORU on the worker side auto-acks and aborts the LLM.

```
Agent A (Planner)                         Agent B (Developer) [status=busy]
       │                                          │
       │── task_cancel ──────────────────────────▶│
       │   content: "Cancelled by user"           │
       │   (task_id=42)                           │
       │                                  [MAMORU] │← auto task_cancel_ack
       │                                  [MAMORU] │← status→available
       │                                  [MAMORU] │← LLM abort signal
       │◀──────────────── task_cancel_ack ────────│
       │   content: "cancelled"                    │
```

**What MAMORU auto-handles on B:** Sends `task_cancel_ack`, sets status → `available`, clears `activeTask`, aborts the LLM session.

### Broadcasting: Agent Join

When an agent joins, MAMORU automatically broadcasts to all teammates. This is handled entirely by MAMORU — neither the LLM nor the user triggers it.

```
Agent A (Designer)         Agent B (Developer)          New Agent C (Tester)
       │                          │                            │
       │                          │                    [start] │
       │                          │                    [MAMORU] │← register in DB
       │                          │                    [MAMORU] │← init cursor (skip to MAX)
       │                          │                    [MAMORU] │← load roster from DB
       │◀──────── broadcast (agent_join) ─────────────────────│
       │  content: "Tester has joined the channel"             │
       │  intent: "agent_join"                                 │
       │                          │◀── broadcast (agent_join) ─│
       │                          │                            │
[MAMORU]│← add to roster          │                            │
[MAMORU]│← refresh send_message   │                            │
       │                  [MAMORU]│← add to roster             │
       │                  [MAMORU]│← refresh send_message      │
```

**What reaches the LLM:** Nothing. `agent_join` broadcasts are handled entirely by MAMORU (roster update + tool description refresh). The LLM discovers the new teammate through the updated `send_message` tool description on its next turn.

### Broadcasting: Agent Leave

```
Agent A (Designer)         Agent B (Developer)          Agent C (Tester)
       │                          │                            │
       │                          │                     [stop] │
       │                          │                    [MAMORU] │← broadcast agent_leave
       │◀──────── broadcast (agent_leave) ────────────────────│
       │  content: "Tester has left the channel"               │
       │  intent: "agent_leave"                                │
       │                          │◀── broadcast (agent_leave) │
       │                          │                    [MAMORU] │← status→inactive
       │                          │                            │
[MAMORU]│← remove from roster     │                            │
[MAMORU]│← refresh send_message   │                            │
       │                  [MAMORU]│← remove from roster        │
       │                  [MAMORU]│← refresh send_message      │
```

### Broadcasting: Team Announcement

An agent broadcasts a general message to the whole team. Unlike `agent_join`/`agent_leave`, general broadcasts **are** forwarded to the LLM.

```
Agent A (Designer)         Agent B (Developer)          Agent C (Tester)
       │                          │                            │
       │── broadcast ────────────▶│                            │
       │  ───────────────────────────────────────────────────▶│
       │  content: "Hi everyone, deployment is done"           │
       │  to_agent: NULL (broadcast)                           │
       │                          │                            │
       │                  [MAMORU]│← forward to LLM (steer)    │
       │                          │                    [MAMORU]│← forward to LLM (steer)
```

**What reaches the LLM:** General broadcasts (no special intent like `agent_join`/`agent_leave`/`agent_status_change`) are forwarded to every teammate's LLM via `steer`, so agents can react to announcements.

### Broadcasting: Mid-Session Join (Dynamic Scaling)

A task turns out to be complex. The user opens a new terminal and adds a specialist mid-session.

```
Terminal 1 (Designer)      Terminal 2 (Developer)       Terminal 3 (new)
       │                          │                            │
       │  [busy with task]        │  [busy with task]          │
       │                          │                            │
       │                          │                    $ pi --team-channel forex-rt \
       │                          │                      --agent-name accessibility-reviewer
       │                          │                    [MAMORU] │← register, init cursor
       │                          │                    [MAMORU] │← broadcast agent_join
       │◀──────── broadcast (agent_join) ─────────────────────│
       │  content: "accessibility-reviewer has joined"         │
       │                          │◀── broadcast (agent_join) ─│
       │                          │                            │
[MAMORU]│← add to roster          │                            │
       │  (3 teammates now)       │                            │
       │                  [MAMORU]│← add to roster             │
       │                          │  (3 teammates now)         │
       │                          │                            │
       │  Next time the LLM uses send_message, it sees:        │
       │  "accessibility-reviewer" (session: xyz) — available  │
```

The new teammate's MAMORU loads the existing roster from the `agents` table, so it immediately knows about the designer and developer. No messages are replayed — the cursor skips to `MAX(message_id)`.

---

## Further Reading

- [Why Build a Teammate System?](00-why-build-teammate.md) — The motivation behind teammate vs. subagent architectures
- [Designing a Teammate-Based Multi-Agent System](01-teammate-design.md) — Architecture, design principles, and a walkthrough example
- [Communication & Messaging](02-teammate-communication.md) — SQLite message bus, payload schema, MAMORU internals
