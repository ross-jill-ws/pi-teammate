---
name: pi-teammate-template
description: Scaffold and maintain pi-teammate folders, each holding a persona.yaml. Use when the user wants to initialize a team of teammates/agents in the current repo, add a teammate to an existing team, or change an existing teammate's persona, role, model, or voice.
---

# Build and maintain a teammate roster

A teammate is a directory whose only required file is `persona.yaml` — `pi` reads it on session start to set that agent's name, model, and private instructions. The **roster** is the set of those directories.

## STEP 1 — Survey the roster, then pick the mode

Always start by finding the teammates that already exist — every mode depends on knowing them:

```bash
find . -maxdepth 3 -name persona.yaml -not -path "*/node_modules/*" -not -path "*/.git/*" \
  -exec sh -c 'echo "--- $1"; grep -E "^(name|model|voiceId):" "$1"' _ {} \;
```

Those three keys are single-line scalars, so grep is enough to place every teammate. `description` and `systemPrompt` are block scalars — read any file you are about to change in full instead of grepping it.

That output settles the mode:

| Mode | When | In scope |
|---|---|---|
| **create** | no teammate folders found, or the user asked for a fresh team | every teammate named |
| **add** | folders exist and the user wants one or more new teammates | only the new folders |
| **update** | the user wants an existing teammate changed — role, model, voice, boundary | only the named `persona.yaml` files |

The survey also constrains whatever you write next: names must stay distinct across the whole roster, `voiceId`s must stay distinct, and any hand-off you write must name a teammate that actually exists.

### create and add

Pull out of the instruction, for each new teammate: **name**, **role**, and **boundary** (what it owns, what it hands off). Ask for everything still missing in a **single** round of questions with concrete options — not one question per teammate per field.

When the user named no teammates, offer this starter roster (it mirrors [pi-teammate-samples](https://github.com/ross-jill-ws/pi-teammate-samples)):

| Folder | Name | Role and boundary |
|---|---|---|
| `designer/` | Rachel | UI/UX direction and browser-based visual review; never writes code |
| `developer/` | Drew | Builds and edits all code; makes no design calls |
| `tester/` | Joseph | Runs builds and tests, reviews diffs; never signs off without a green run |

Add-ons worth offering: `researcher` (gathers docs and API facts), `reviewer` (security and performance critique), `writer` (docs, release notes), `data` (schema and query work).

Default the parent folder to the repo root. The channel name defaults to that folder's own name — which is what `launch-team.sh` uses in STEP 3, so leave it alone unless the user names a channel.

In **add** mode, a new teammate usually steals responsibility from someone. If the new role overlaps an existing boundary — a reviewer arriving where the developer used to self-approve — say which existing `persona.yaml` should change and get the user's go-ahead before touching it. Fold any approved edits into the update work below; leave the file alone otherwise.

### update

Name exactly which teammates and which fields change. Read each target `persona.yaml` in full first — you are editing it, not regenerating it.

**Done when:** the mode is chosen, every in-scope teammate has a folder path, and for create/add each has a distinct name and a one-line boundary; parent folder and channel name are fixed.

## STEP 2 — Write each persona.yaml

In **create** and **add** mode, `mkdir -p <folder>` per new teammate and write the file. If a `persona.yaml` is already sitting there, ask before overwriting it.

In **update** mode, edit the existing file in place and change only the fields the user asked about. Every other key keeps its current value — the defaults below apply to new files only, so never let them silently move a teammate's model or voice.

Only these keys are read (`extensions/persona.ts`, `mamoru.ts`, `tts.ts`). Do not invent others.

| Key | Default | Notes |
|---|---|---|
| `name` | required | Display name, broadcast to the team; also becomes the agent name, so `--agent-name` is never needed |
| `description` | required | Broadcast; teammates read it to decide who to delegate to. Empty value throws on load |
| `provider` | `openai-codex` | Applied only together with `model` |
| `model` | `gpt-5.6-sol` | Never set one of provider/model without the other |
| `thinkingLevel` | `high` | `off`, `low`, `medium`, `high` only — pi's own `minimal`/`xhigh`/`max` are rejected and throw |
| `systemPrompt` | — | Private instructions. When present it **replaces** `description` in this agent's system prompt |
| `contentWordLimit` | 20 | Max words per outbound message `content` |
| `voiceId` | see *Assigning voices* | `"none"` hard-disables TTS for this agent |

### Assigning voices

In **update** mode, leave `voiceId` exactly as it is unless the user asked about audio. Otherwise take the first case that applies:

1. **The user named voices** — use what they gave. A raw id goes in verbatim; a voice *name* gets resolved against the listing below.
2. **`ELEVENLABS_API_KEY` is unset** — write `voiceId: "none"` for every teammate and move on. No lookup, no questions.
3. **The key is set and the user said nothing about audio** — list the account's voices and give each teammate a distinct one that fits its persona: gender implied by the teammate's name, and the accent, description, and use-case labels weighed against the role (a reviewer reads better in a calm professional voice than a character voice).

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices \
  | python3 -c "import json,sys
for v in json.load(sys.stdin)['voices']:
    l = v.get('labels') or {}
    print(v['voice_id'], '|', v['name'], '|', l.get('gender',''), l.get('accent',''), l.get('description',''), l.get('use_case',''))"
```

Every id must come from the user or from that listing — never from memory. Nothing validates `voiceId`, so a wrong one fails only at playback, with a `[tts] ❌` line on stderr and no TUI notification; that agent simply goes mute for the whole session. Give each teammate its own id, including against the `voiceId`s the STEP 1 survey already found, since one shared voice makes the audio feed unreadable. If the listing call fails, write `"none"` everywhere and say so in the report.

### Shape

2-space indent, quoted scalars, `>` block scalars for prose:

```yaml
name: "Drew"
provider: "openai-codex"
model: "gpt-5.6-sol"
thinkingLevel: "high"
voiceId: "none"          # or an id from the listing — see Assigning voices
description: >
  Fullstack developer specialized in TypeScript and React. Builds UI
  components, routing, server-side logic, and API integrations.
systemPrompt: >
  You are a senior fullstack developer. You write clean, type-safe code
  with proper error handling, and you own every build-facing change.

  You make no design decisions — visual direction and layout critique go
  to Rachel. You do not sign off your own work; hand finished changes to
  Joseph for review and test execution.
```

Write the **boundary** into every `systemPrompt`: a `You are a …` opener, the concrete actions this agent owns, and the work it hands to a *named* teammate instead of doing itself. A roster without boundaries collapses into every agent doing everything. Keep `description` external-facing (what a teammate needs in order to route work) and `systemPrompt` in second person.

Omit any key you have no value for — an empty string breaks `description` and adds noise everywhere else.

**Done when:** every in-scope `persona.yaml` has a `systemPrompt` naming at least one hand-off to a teammate that exists, and a `voiceId` that is `"none"` or an id unique across the roster; and in update mode, every key you were not asked to change still holds the value it had before.

## STEP 3 — Drop in the launcher

`launch-team.sh` sits next to this SKILL.md. Copy it into the parent folder — the directory holding the teammate folders — and make it executable:

```bash
cp <the directory this SKILL.md lives in>/launch-team.sh <parent>/launch-team.sh
chmod +x <parent>/launch-team.sh
```

It needs no editing. It finds every directory under it holding a `persona.yaml`, defaults the channel to the parent folder's name, splits the terminal into one pane per teammate (iTerm2 when you are in iTerm2, tmux otherwise), and starts a `pi` session in each. Slot 1 creates the channel with `--team-new`; the others wait for `~/.pi/pi-teammate/<channel>/team.db` before joining, because `--team-new` deletes the whole channel directory and would otherwise wipe a joiner that got there first.

In **add** mode the file is probably already there — leave it alone, it will pick the new teammate up on its own.

Pane layouts are defined for 1–6 teammates (`1x2`, `2x2`, `1x3 + 1x2`, `3x2`, …). A larger roster exits with a message rather than guessing a layout; launch the overflow from a second window.

**Done when:** `<parent>/launch-team.sh dry-run=1` lists every teammate in the intended slot with the right channel.

## STEP 4 — Give a teammate its own skills

Only when the user asked for it. `pi` loads project skills from `<teammate-folder>/.pi/skills/`, so a skill linked there belongs to that teammate alone — this is how one agent gets browser access and the others don't.

```bash
mkdir -p <folder>/.pi/skills
ln -s "<resolved-source>" "<folder>/.pi/skills/<skill>"
```

Resolve `<skill>` against, in order: a path the user gave, `$HOME/workspace/ai-tools/skills/mine_general/<skill>`, `$HOME/workspace/ai-tools/skills/others_general/<skill>`. Confirm the source directory exists before linking; when none match, name the missing skill to the user rather than leaving a dangling link.

**Done when:** `ls -lL <folder>/.pi/skills` resolves every link for every teammate that requested skills.

## STEP 5 — Prove every persona loads

Run the real loader across the whole roster — every teammate, not just the ones you touched. An invalid `thinkingLevel` or empty `description` throws here instead of degrading silently at session start:

```bash
LOADER="$(npm root -g)/pi-teammate/extensions/persona.ts"   # inside the pi-teammate repo, use ./extensions/persona.ts
bun -e "import {loadPersona} from '$LOADER'; for (const d of process.argv.slice(1)) { const p = loadPersona(d); console.log(d, '->', p?.name, p?.provider + '/' + p?.model, p?.thinkingLevel); }" <folder1> <folder2>
```

**Done when:** the command prints one line per teammate with the expected name and model, no two lines share a name, and it exits clean. On a throw, fix the file and re-run.

## STEP 6 — Report

Start the team with one command:

```bash
./launch-team.sh
```

In **add** mode, the team is already running — launch only the new teammate, and keep the existing channel:

```bash
./launch-team.sh fresh=0 <new-folder>
```

A teammate whose `persona.yaml` you edited while its session was running needs to re-join before the change lands — MAMORU captures `name`, `description`, `systemPrompt`, and `contentWordLimit` once, when the team is joined, and broadcasts that snapshot to the roster. Tell the user to run `/team-leave` then `/team-join <channel>` in that session, or restart it. `/reload` alone only re-applies `provider`, `model`, and `thinkingLevel`.

If `pi list` does not show `pi-teammate`, `pi install npm:pi-teammate` has to come first.

Also report any skills linked per teammate, plus anything requested that was not found. When voices were auto-assigned, name the voice each teammate got so the user can swap any that don't suit. The persona files are on disk — summarize them, don't print them back.
