# Claude Code Teammate — Setup & Launch

This is the practical companion to [Claude Code as a Teammate](04-claude-code-teammate.md): the files a Claude Code teammate needs, how to start it, how `launch-team.sh` treats mixed pi/Claude Code rosters, and what to do when notifications don't arrive.

The fastest path is to not do any of this by hand — the bundled `pi-teammate-template` skill scaffolds everything below when you ask for a teammate on the `anthropic` provider ("make Drew a Claude Code teammate"). This document explains what it generates and why.

---

## The three artifacts

A Claude Code teammate is a folder with up to three files. Only the first two are required.

```
project/
└── developer/
    ├── persona.yaml            # identity — same file every teammate has
    ├── .mcp.json               # starts the mcp-teammate server on session open
    └── .claude/settings.json   # optional voice hooks
```

### 1. `persona.yaml`

Same schema as any teammate, with two runtime rules: `provider` must be `"anthropic"` (this is what marks the folder as a Claude Code teammate), and pi-only runtime keys like `thinkingLevel` are omitted — Claude Code manages its own reasoning settings.

```yaml
name: "Drew"
provider: "anthropic"
model: "opus"
voiceId: "none"
description: >
  Fullstack developer specialized in TypeScript and React.
systemPrompt: >
  You are a senior fullstack developer. You own every build-facing change.
  Hand finished work to Joseph for review; design calls go to Rachel.
```

`name` and `description` are broadcast to the roster; `systemPrompt` and `description` are injected into the session via the MCP server's instructions.

### 2. `.mcp.json`

Claude Code reads this on session start and launches the `mcp-teammate` stdio server. The script path must be **absolute** — the server resolves its own dependencies from the pi-teammate package, so it runs from any folder:

```json
{
  "mcpServers": {
    "mcp-teammate": {
      "command": "bun",
      "args": ["<absolute-path-to>/skills/pi-teammate-template/scripts/teammate-mcp.ts"],
      "env": { "MCP_TEAMMATE_AUTOJOIN_CHANNEL": "my-project" }
    }
  }
}
```

With a global install the script lives at `$(npm root -g)/pi-teammate/skills/pi-teammate-template/scripts/teammate-mcp.ts`.

`MCP_TEAMMATE_AUTOJOIN_CHANNEL` makes the session join the channel automatically, reading `persona.yaml` from the folder. Drop the `env` block to join manually with `/mcp__mcp-teammate__team-join <channel>` instead. Optional tuning knobs: `MCP_TEAMMATE_AUTOJOIN_AGENT_NAME`, `MCP_TEAMMATE_AUTOJOIN_PERSONA_PATH`, `MCP_TEAMMATE_POLL_INTERVAL_MS`, `MCP_TEAMMATE_STALE_HEARTBEAT_MS`.

### 3. `.claude/settings.json` — voice hooks (optional)

Only when `ELEVENLABS_API_KEY` is set and the persona's `voiceId` is not `"none"`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup", "hooks": [{ "type": "command", "command": "bun <path>/scripts/tts-say.ts 'Drew is online'" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "bun <path>/scripts/tts-say.ts 'Drew has finished'" }] }
    ]
  }
}
```

`tts-say.ts` reads `voiceId` from the folder's `persona.yaml` and exits silently on any failure — a broken key never blocks the session.

---

## Launching by hand

Start the session from the teammate's folder:

```bash
cd project/developer
claude --dangerously-skip-permissions --dangerously-load-development-channels server:mcp-teammate
```

- `--dangerously-load-development-channels server:mcp-teammate` is required for inbound channel notifications while Claude Code channels are in research preview. Accept the "local development" dialog at startup.
- `--dangerously-skip-permissions` lets the teammate act autonomously — the same trust level a pi teammate runs at. Drop it if you want to approve each action.

**Order matters:** start the Claude Code session *after* the channel exists — a pi teammate created it with `--team-new`, or `/team-create` ran. Starting earlier risks the launcher's `--team-new` deleting the channel directory out from under a registration that already happened. (Only when the roster has no pi teammate at all does the Claude Code session's auto-join create the channel itself.)

---

## Launching with `launch-team.sh`

The launcher handles mixed rosters on its own. It detects a Claude Code teammate by its `persona.yaml` saying `provider: "anthropic"` or by a `.mcp.json` that starts `teammate-mcp`, and then treats the two runtimes differently:

- **pi teammates auto-start** exactly as before — each pane runs `pi --team-channel <channel>`.
- **A Claude Code teammate's pane runs nothing.** It opens in the teammate's folder, prints the `claude` launch command plus the join instructions, and leaves you at a shell. You run the command once the pi panes are up.
- **The channel creator is the first *pi* teammate** in the roster, not blindly slot 1 — a Claude Code pane cannot run `--team-new`. The other pi panes wait for `team.db` to appear before joining.

A dry run shows the plan, with each runtime marked:

```
$ ./launch-team.sh dry-run=1
channel:   my-project
teammates: 3 — layout 1x2 + 1x1
  slot 1  Rachel         designer   (creates the channel)
  slot 2  Drew           developer  (claude code — pane prints the launch command)
  slot 3  Joseph         tester
```

And the Claude Code pane, once open, shows:

```
Claude Code teammate: Drew -- not auto-started.
Once the 'my-project' channel is up (pi panes running), launch it with:

  claude --dangerously-skip-permissions --dangerously-load-development-channels server:mcp-teammate

.mcp.json auto-joins 'my-project' on startup; to join by hand inside
Claude Code, run: /mcp__mcp-teammate__team-join my-project
```

If every teammate in the roster is a Claude Code teammate, the launcher notes that the first session to join will create the channel. Positional arguments still work for launching a subset or fixing pane order: `./launch-team.sh designer developer tester`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Banner says **"Channels are not currently available"** | Feature-flag resolution is disabled — typically `DISABLE_GROWTHBOOK=1` exported in the shell. Launch with `env -u DISABLE_GROWTHBOOK claude ...`. |
| No inbound messages arrive | The session was started without `--dangerously-load-development-channels server:mcp-teammate`, or the "local development" dialog was declined. Restart with the flag. |
| Auto-join didn't happen | `.mcp.json` missing the `env` block, or the server failed to start (check the script path is absolute and `bun` is on `PATH`). Join manually: `/mcp__mcp-teammate__team-join <channel>`. |
| Teammate registered, then vanished from the roster | A pi teammate ran `--team-new` *after* the Claude Code session joined, wiping the channel directory. Restart order: pi creator first, Claude Code sessions after. `/mcp__mcp-teammate__team-join <channel>` re-joins without restarting. |
| Persona edits not picked up | Like pi teammates, persona is captured at join time. `/mcp__mcp-teammate__team-leave` then `team-join` again. |
| Agent goes mute in the audio feed | Wrong `voiceId` — it fails only at playback with a `[tts] ❌` on stderr. Fix the id in `persona.yaml`. |
