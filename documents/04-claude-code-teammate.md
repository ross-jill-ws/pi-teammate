# Claude Code as a Teammate

`pi-teammate` was built so that every agent on a channel is an equal peer — and that peer does not have to be a `pi` session. A **Claude Code teammate** is a regular Claude Code session that joins the same channel, appears on the same roster, and exchanges the same task messages as every pi agent. To the rest of the team it is indistinguishable from any other teammate.

This matters because the two runtimes bring different strengths to one table:

- **pi teammates** are cheap to fan out, launch unattended from `launch-team.sh`, and can run any provider/model pi supports.
- **A Claude Code teammate** brings the whole Claude Code ecosystem with it — its skills, its MCP servers, its subagents, its permission model, and Anthropic's strongest models — while still collaborating as a peer instead of sitting outside the team.

A typical mixed roster: a pi designer and pi tester coordinating with a Claude Code developer that does the heavy code work.

---

## Same contract, different transport

Nothing about the team contract changes. A Claude Code teammate still:

- lives in a folder with a `persona.yaml` (same fields, same loader semantics),
- registers into the same channel database at `~/.pi/pi-teammate/<channel>/team.db`,
- is guarded by the same **MAMORU** loop — auto-ack, busy handling, roster upkeep, heartbeats,
- shows up in `/team-roster`, the task tracker, and [pi-teammate-ui](https://www.npmjs.com/package/pi-teammate-ui) like everyone else.

What changes is *where MAMORU runs*. In a pi session it is a pi extension; in Claude Code it runs inside a small **stdio MCP server** called `mcp-teammate` (`skills/pi-teammate-template/scripts/teammate-mcp.ts`), started automatically by a `.mcp.json` in the teammate's folder. The server wraps MAMORU plus a notifier and exposes the pi-teammate command set to the Claude Code TUI.

```
┌─ Claude Code session ─────────────────────────┐
│  model ⇄ tools: send-message-to-teammate,     │
│               get-team-roster                 │
│  TUI    ⇄ prompts: /mcp__mcp-teammate__*      │
│        ▲                                      │
│        │ notifications/claude/channel (push)  │
│  ┌─────┴──────── mcp-teammate ─────────────┐  │
│  │  MAMORU  ⇄  ~/.pi/pi-teammate/<ch>/team.db │
│  └──────────────────────────────────────────┘ │
└───────────────────────────────────────────────┘
```

### Receiving messages

Inbound channel events are pushed to the model over `notifications/claude/channel` — the model-visible notification path while Claude Code channels are in research preview (hence the `--dangerously-load-development-channels` launch flag). Each notification carries a short rendered `content` plus `meta` fields such as `event`, `task_id`, and `from`.

MAMORU filters exactly as it does in pi: mechanical traffic (acks, rejects, roster updates, heartbeats) is absorbed silently, and only messages that need real reasoning — a `task_req`, a `task_clarify`, a `task_done` for work this agent delegated — reach the model. On an inbound `task_req`, MAMORU has already ack'd and marked the agent busy before the model even sees it; the model just does the work and replies.

### Sending messages

Outbound traffic goes through two MCP tools, mirroring the pi tool surface:

| Tool | Purpose |
|---|---|
| `send-message-to-teammate` | Send `task_req`, `task_done`, `task_fail`, `task_update`, `task_clarify`, `broadcast`, … |
| `get-team-roster` | Fresh roster snapshot — called before every send, since the roster changes between turns |

The messaging rules are identical to pi's: `content` stays within the word limit (20 by default), and anything longer goes into a markdown **detail file** under `~/.pi/pi-teammate/<channel>/<session-id>/`, passed by absolute path. Reserved events (`ping`, `pong`, `task_ack`, `task_reject`, `task_cancel_ack`) remain MAMORU-only.

### Slash commands in the TUI

Every pi-teammate slash command is exposed as an MCP prompt, so the user drives the team from the Claude Code TUI under the `/mcp__mcp-teammate__` prefix:

| Prompt | Purpose |
|---|---|
| `team-create` | Create (or recreate) a channel DB — deletes existing channel data |
| `team-join` | Join a channel and start MAMORU polling |
| `team-leave` | Leave the current channel |
| `team-remove-inactive` | Clean up stale sessions sharing this agent's name |
| `team-send` | Manual debug broadcast to a teammate |
| `team-status` / `team-roster` / `team-history` | Inspect channel, roster, recent messages |
| `task-status` / `task-list` / `task-cancel` / `task-history` | Inspect and manage tasks |
| `persona-template` | Write a starter `persona.yaml` into the current directory |

For example, joining a channel by hand is:

```
/mcp__mcp-teammate__team-join forex-rt
```

`team-join` creates the channel database if it does not exist yet, loads `persona.yaml` from the working directory for the agent's name and description, and starts MAMORU.

### Auto-join

Most of the time nobody types that command. The `.mcp.json` sets `MCP_TEAMMATE_AUTOJOIN_CHANNEL`, and the server joins that channel the moment the MCP handshake completes — reading `persona.yaml` from the folder exactly like a pi session would at startup. Two more env vars, `MCP_TEAMMATE_AUTOJOIN_AGENT_NAME` and `MCP_TEAMMATE_AUTOJOIN_PERSONA_PATH`, override the name and persona location when needed.

### Persona injection

A pi session applies `systemPrompt` directly. The MCP server achieves the same effect through MCP `instructions`: the persona's `systemPrompt` and `description` are prepended to the server's participation guide, which Claude Code folds into the session's context. `name` and `description` are broadcast to the roster as usual. `provider` and `model` are not applied here — the Claude Code session's own model settings govern; that is why a Claude Code persona never sets `thinkingLevel`.

### Leaving cleanly

On `SIGINT`, `SIGTERM`, or the stdio pipe closing (i.e. the Claude Code session ending), the server broadcasts `agent_leave` and closes the database — the rest of the team sees the departure immediately, the same as a pi teammate quitting.

### Voice

If the team uses ElevenLabs TTS, a Claude Code teammate participates through hooks in its `.claude/settings.json` (`SessionStart` / `Stop` announcements via `scripts/tts-say.ts`, which reads `voiceId` from the folder's `persona.yaml`). Message-by-message speech follows the same shared `voice_queue` rules as pi agents.

---

## What the rest of the team sees

Nothing special. The Claude Code teammate joins with a broadcast, appears on the roster with its persona name and description, acks tasks through MAMORU, heartbeats, and leaves with a broadcast. A pi designer delegating to it cannot tell — and does not need to know — that the worker on the other end is a Claude Code session.

That symmetry is the point: the channel is the contract, and any runtime that speaks it is a teammate.

---

*Next: [Claude Code Teammate — Setup & Launch](05-claude-code-teammate-setup.md) for the concrete artifacts, the launcher behavior in mixed teams, and troubleshooting.*
