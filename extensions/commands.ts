/**
 * Slash commands for pi-teammate.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MamoruOverlay } from "./tui/mamoru-overlay.ts";
import { RosterDetailOverlay, TaskDetailOverlay } from "./tui/detail-overlay.ts";
import type Database from "better-sqlite3";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initSchema } from "./schema.ts";
import { parsePayload, createPayload } from "./types.ts";
import type { MessageRow, MessagePayload } from "./types.ts";
import { sendMessage, getMessagesByTaskId } from "./db.ts";
import type { Mamoru } from "./mamoru.ts";
import { getChannelDir, getDbPath, channelExists } from "./paths.ts";
import { loadPersona } from "./persona.ts";

// ── Slash-command usage hints ───────────────────────────────────
//
// We want to show a usage hint via ctx.ui.notify whenever the user has
// typed (or autocompleted) one of our slash commands and is now positioned
// to type its arguments — i.e. when the editor text is exactly "/cmd ".
// This must work for both manual paths:
//   1. typing "/team-join" then a space
//   2. typing "/team-joi" then Tab (which expands to "/team-join ")
//
// pi-tui only invokes `getArgumentCompletions` for path #1 (after the next
// keystroke), so we cannot rely on it for the Tab path. Instead we install
// a global terminal-input listener and re-check the editor text after each
// keystroke (deferred via setImmediate so the editor has finished applying
// the input). The hint registry is built up alongside command registration
// and exposed via getCommandHintRegistry().
//
// `getArgumentCompletions` is still wired up so the autocomplete dropdown
// shows the example values for each command, but it is now a pure pure
// function with no notification side-effects.

export interface UsageHint {
  /** One-line summary, shown via ctx.ui.notify when the user enters the command's argument area */
  summary: string;
  /** Concrete examples, shown both in the notification and as autocomplete entries */
  examples: { value: string; label: string; description: string }[];
}

/** Format a UsageHint as a multi-line notification body. */
export function formatUsageHint(hint: UsageHint): string {
  const lines = [hint.summary];
  if (hint.examples.length > 0) {
    lines.push("", "Examples:");
    for (const ex of hint.examples) {
      lines.push(`  ${ex.value}`);
      if (ex.description) lines.push(`    — ${ex.description}`);
    }
  }
  return lines.join("\n");
}

function makeArgumentCompletions(
  hint: UsageHint,
): (prefix: string) => { value: string; label: string; description?: string }[] | null {
  return (prefix: string) => {
    const filtered = hint.examples.filter((e) =>
      e.value.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    return filtered.length > 0 ? filtered : null;
  };
}

/**
 * Install a terminal-input listener that fires the usage-hint notification
 * whenever the editor text is exactly "/<cmd> " (one of our registered
 * commands followed by a single space). The listener fires once per
 * "entry" into that state — if the user types args, leaves the state, and
 * comes back, the hint re-fires.
 *
 * Returns an unsubscribe function. Safe to call when ctx.ui.onTerminalInput
 * is unavailable (e.g. RPC mode).
 */
export function setupHintWatcher(
  ctx: ExtensionContext,
  hints: Map<string, UsageHint>,
): () => void {
  if (typeof (ctx.ui as any).onTerminalInput !== "function") {
    return () => {};
  }
  if (typeof (ctx.ui as any).getEditorText !== "function") {
    return () => {};
  }

  // Track the command we last notified for, so we don't spam on every
  // keystroke. Reset to null whenever the editor text leaves a "/cmd "
  // state, so re-entering the state re-fires the hint.
  let lastNotifiedCommand: string | null = null;

  const check = () => {
    let text: string;
    try {
      text = (ctx.ui as any).getEditorText();
    } catch {
      return;
    }

    // Match exactly "/<cmd> " — the user is at the start of arguments.
    // We deliberately allow trailing whitespace-only content (the editor
    // sometimes lands with a single space after a Tab completion) but not
    // any non-whitespace, since once they start typing args they should
    // not be re-notified.
    const match = /^\/([\w-]+)\s*$/.exec(text);
    if (match && /\s$/.test(text)) {
      const cmd = match[1];
      if (hints.has(cmd) && lastNotifiedCommand !== cmd) {
        lastNotifiedCommand = cmd;
        ctx.ui.notify(formatUsageHint(hints.get(cmd)!), "info");
      }
      return;
    }

    // Not in a "/cmd " state — reset so the next entry re-fires.
    lastNotifiedCommand = null;
  };

  const handler = (_data: string) => {
    // Defer until the editor has applied the input.
    setImmediate(check);
    return undefined;
  };

  return (ctx.ui as any).onTerminalInput(handler);
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function registerCommands(
  pi: ExtensionAPI,
  getMamoru: () => Mamoru | null,
  setMamoru: (m: Mamoru | null) => void,
  getCtx: () => ExtensionContext | null,
  opts: {
    bootstrapMamoru: (ctx: ExtensionContext, channel: string, agentName: string) => void;
  },
): { hintRegistry: Map<string, UsageHint> } {
  // Per-registration registry of slash-command usage hints. Built up below
  // as each command is registered. Returned to the caller (index.ts) which
  // wires up setupHintWatcher in session_start.
  const hintRegistry = new Map<string, UsageHint>();

  function defineHint(commandName: string, hint: UsageHint): UsageHint {
    hintRegistry.set(commandName, hint);
    return hint;
  }
  // ── /team-create [name] ─────────────────────────────────────────
  pi.registerCommand("team-create", {
    description: "Create (or recreate) a team channel DB. Deletes existing channel data if present. Usage: /team-create [channelName]",
    getArgumentCompletions: makeArgumentCompletions(defineHint("team-create", {
        summary: "Usage: /team-create [channelName]",
        examples: [
          { value: "my-team", label: "my-team", description: "Create a channel named 'my-team'" },
          { value: "dev", label: "dev", description: "Create a channel named 'dev'" },
        ],
      })),
    handler: async (args, ctx) => {
      const channelName = args.trim() || ctx.sessionManager.getSessionId();
      const channelDir = getChannelDir(channelName);
      const dbPath = getDbPath(channelName);

      // Delete existing channel folder if present
      if (existsSync(channelDir)) {
        const { rmSync } = await import("node:fs");
        rmSync(channelDir, { recursive: true, force: true });
        ctx.ui.notify(`Deleted existing channel: ${channelDir}`, "info");
      }

      mkdirSync(channelDir, { recursive: true });

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath);
      try {
        initSchema(db);
      } finally {
        db.close();
      }

      ctx.ui.notify(`Created channel DB: ${dbPath}`, "info");
    },
  });

  // ── /team-join <channel> [agentName] ────────────────────────────
  pi.registerCommand("team-join", {
    description: "Join a team channel and start polling. Usage: /team-join <channel> [agentName]",
    getArgumentCompletions: makeArgumentCompletions(defineHint("team-join", {
        summary: "Usage: /team-join <channel> [agentName]",
        examples: [
          { value: "dev", label: "dev", description: "Join channel 'dev' (agent name from persona.yaml or session id)" },
          { value: "dev Alice", label: "dev Alice", description: "Join channel 'dev' as 'Alice'" },
          { value: "my-team Bob", label: "my-team Bob", description: "Join channel 'my-team' as 'Bob'" },
        ],
      })),
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const channel = parts[0];
      if (!channel) {
        ctx.ui.notify("Usage: /team-join <channel> [agentName]", "error");
        return;
      }

      // Agent name precedence: explicit arg > persona.yaml name > session id
      let agentName = parts[1];
      if (!agentName) {
        try {
          const persona = loadPersona(ctx.cwd);
          if (persona?.name) agentName = persona.name;
        } catch {
          // ignore persona errors here — they're already surfaced on session_start
        }
      }
      if (!agentName) {
        agentName = ctx.sessionManager.getSessionId();
      }

      // Check if already joined
      const existing = getMamoru();
      if (existing) {
        ctx.ui.notify(
          `Already joined "${existing.getChannel()}" as "${existing.getAgentName()}". Use /team-leave first.`,
          "warning",
        );
        return;
      }

      try {
        opts.bootstrapMamoru(ctx, channel, agentName);
        ctx.ui.notify(`Joined channel "${channel}" as "${agentName}"`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to join: ${err.message}`, "error");
      }
    },
  });

  // ── /team-leave ─────────────────────────────────────────────────
  pi.registerCommand("team-leave", {
    description: "Leave the current team channel",
    getArgumentCompletions: makeArgumentCompletions(defineHint("team-leave", {
        summary: "Usage: /team-leave (no arguments)",
        examples: [],
      })),
    handler: async (_args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "warning");
        return;
      }

      const channel = mamoru.getChannel();
      const name = mamoru.getAgentName();
      mamoru.stop();
      setMamoru(null);
      ctx.ui.setStatus("teammate", "mamoru: inactive");
      ctx.ui.notify(`Left channel "${channel}" (was "${name}")`, "info");
    },
  });

  // ── /team-send <to> <message> ──────────────────────────────────
  pi.registerCommand("team-send", {
    description: "Send a manual message for debugging. Usage: /team-send <to> <message>",
    getArgumentCompletions: makeArgumentCompletions(defineHint("team-send", {
        summary: "Usage: /team-send <to_session_id> <message>",
        examples: [
          { value: "alice hello", label: "alice hello", description: "Send 'hello' to agent 'alice'" },
          { value: "<session_id> <message>", label: "<session_id> <message>", description: "Manually send a debug message to a teammate" },
        ],
      })),
    handler: async (args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel. Use /team-join first.", "error");
        return;
      }

      const parts = args.trim().split(/\s+/);
      const to = parts[0];
      const message = parts.slice(1).join(" ");

      if (!to || !message) {
        ctx.ui.notify("Usage: /team-send <to_session_id> <message>", "error");
        return;
      }

      const payload = createPayload("broadcast", message);

      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath(mamoru.getChannel());
      const db = new Database(dbPath);
      try {
        const msgId = sendMessage(db, {
          from_agent: mamoru.getSessionId(),
          to_agent: to,
          channel: mamoru.getChannel(),
          task_id: null,
          ref_message_id: null,
          payload: JSON.stringify(payload),
        });
        ctx.ui.notify(`Message #${msgId} sent to "${to}"`, "info");
      } finally {
        db.close();
      }
    },
  });

  // ── /team-status ────────────────────────────────────────────────
  pi.registerCommand("team-status", {
    description: "Show current team connection status",
    handler: async (_args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "info");
        return;
      }

      const activeTask = mamoru.getActiveTask();
      const outbound = mamoru.getOutboundTasks();

      const lines = [
        `Channel: ${mamoru.getChannel()}`,
        `Agent: ${mamoru.getAgentName()} (${mamoru.getSessionId()})`,
        `Status: ${mamoru.getStatus()}`,
        `Active Task: ${activeTask ? `#${activeTask.taskId} from ${activeTask.requesterSessionId} (started ${formatElapsed(Date.now() - activeTask.startedAt)} ago)` : "none"}`,
        `Outbound Tasks: ${outbound.size}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /team-roster ────────────────────────────────────────────────
  pi.registerCommand("team-roster", {
    description: "Show all agents in the roster",
    handler: async (_args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const roster = mamoru.getRoster();
      const entries = roster.getAll();

      if (entries.length === 0) {
        ctx.ui.notify("Roster is empty (no other agents online).", "info");
        return;
      }

      const lines = entries.map(
        (e) =>
          `  ${e.agent_name} (${e.session_id}) — ${e.status} — ${e.description || "(no description)"}`,
      );

      ctx.ui.notify(`Roster (${entries.length} agents):\n${lines.join("\n")}`, "info");
    },
  });

  // ── /team-history [n] ──────────────────────────────────────────
  pi.registerCommand("team-history", {
    description: "Show last N messages on the channel. Usage: /team-history [n] (default 20)",
    getArgumentCompletions: makeArgumentCompletions(defineHint("team-history", {
        summary: "Usage: /team-history [n] (default 20)",
        examples: [
          { value: "10", label: "10", description: "Show last 10 messages" },
          { value: "50", label: "50", description: "Show last 50 messages" },
          { value: "100", label: "100", description: "Show last 100 messages" },
        ],
      })),
    handler: async (args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const n = parseInt(args.trim(), 10) || 20;
      const channel = mamoru.getChannel();

      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath(channel);
      const db = new Database(dbPath, { readonly: true });

      try {
        const rows = db
          .prepare("SELECT * FROM messages WHERE channel = ? ORDER BY message_id DESC LIMIT ?")
          .all(channel, n) as MessageRow[];

        if (rows.length === 0) {
          ctx.ui.notify("No messages found.", "info");
          return;
        }

        // Reverse to show oldest first
        rows.reverse();

        const lines = rows.map((row) => {
          const payload = parsePayload(row.payload);
          const event = payload?.event ?? "?";
          const content = payload?.content ?? "(unparseable)";
          const to = row.to_agent ? ` → ${row.to_agent}` : "";
          const task = row.task_id ? ` [task #${row.task_id}]` : "";
          return `#${row.message_id} [${formatTimestamp(row.created_at)}] ${row.from_agent}${to}${task} (${event}): ${content}`;
        });

        ctx.ui.notify(`Last ${rows.length} messages:\n${lines.join("\n")}`, "info");
      } finally {
        db.close();
      }
    },
  });

  // ── /task-status ────────────────────────────────────────────────
  pi.registerCommand("task-status", {
    description: "Show active inbound task and outbound tasks with elapsed time",
    handler: async (_args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const now = Date.now();
      const activeTask = mamoru.getActiveTask();
      const outbound = mamoru.getOutboundTasks();

      const lines: string[] = [];

      if (activeTask) {
        lines.push(`Active (inbound) task #${activeTask.taskId}`);
        lines.push(`  From: ${activeTask.requesterSessionId}`);
        lines.push(`  Started: ${formatElapsed(now - activeTask.startedAt)} ago`);
      } else {
        lines.push("No active inbound task.");
      }

      if (outbound.size > 0) {
        lines.push("");
        lines.push(`Outbound tasks (${outbound.size}):`);
        for (const [taskId, task] of outbound) {
          lines.push(`  #${taskId} → ${task.workerSessionId} (sent ${formatElapsed(now - task.sentAt)} ago, last event ${formatElapsed(now - task.lastEventAt)} ago)`);
        }
      } else {
        lines.push("No outbound tasks.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /task-list ──────────────────────────────────────────────────
  pi.registerCommand("task-list", {
    description: "List all task_req messages on the channel",
    handler: async (_args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const channel = mamoru.getChannel();

      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath(channel);
      const db = new Database(dbPath, { readonly: true });

      try {
        // task_req messages where task_id = message_id (i.e., new task requests)
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE channel = ? AND task_id = message_id ORDER BY message_id DESC",
          )
          .all(channel) as MessageRow[];

        if (rows.length === 0) {
          ctx.ui.notify("No tasks found.", "info");
          return;
        }

        const lines = rows.map((row) => {
          const payload = parsePayload(row.payload);
          const content = payload?.content ?? "(unparseable)";
          const to = row.to_agent ? ` → ${row.to_agent}` : " (broadcast)";
          return `Task #${row.message_id} [${formatTimestamp(row.created_at)}] ${row.from_agent}${to}: ${content}`;
        });

        ctx.ui.notify(`Tasks (${rows.length}):\n${lines.join("\n")}`, "info");
      } finally {
        db.close();
      }
    },
  });

  // ── /task-cancel [task_id] ──────────────────────────────────────
  pi.registerCommand("task-cancel", {
    description: "Cancel an outbound task. Usage: /task-cancel <task_id>",
    getArgumentCompletions: makeArgumentCompletions(defineHint("task-cancel", {
        summary: "Usage: /task-cancel <task_id>",
        examples: [
          { value: "<task_id>", label: "<task_id>", description: "Numeric ID of the outbound task to cancel" },
        ],
      })),
    handler: async (args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const taskId = parseInt(args.trim(), 10);
      if (isNaN(taskId)) {
        ctx.ui.notify("Usage: /task-cancel <task_id>", "error");
        return;
      }

      const outbound = mamoru.getOutboundTasks();
      const task = outbound.get(taskId);
      if (!task) {
        ctx.ui.notify(`No outbound task #${taskId} found.`, "warning");
        return;
      }

      const payload = createPayload("task_cancel", "Cancelled by user", {
        intent: "user_cancel",
        need_reply: true,
      });

      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath(mamoru.getChannel());
      const db = new Database(dbPath);

      try {
        const msgId = sendMessage(db, {
          from_agent: mamoru.getSessionId(),
          to_agent: task.workerSessionId,
          channel: mamoru.getChannel(),
          task_id: taskId,
          ref_message_id: taskId,
          payload: JSON.stringify(payload),
        });
        ctx.ui.notify(`Sent task_cancel for task #${taskId} (message #${msgId})`, "info");
      } finally {
        db.close();
      }
    },
  });

  // ── /persona-template ───────────────────────────────────────
  pi.registerCommand("persona-template", {
    description: "Create a persona.yaml template in the current directory",
    handler: async (_args, ctx) => {
      const filePath = join(ctx.cwd, "persona.yaml");

      if (existsSync(filePath)) {
        ctx.ui.notify(`persona.yaml already exists at ${filePath}. Will not overwrite.`, "error");
        return;
      }

      // Derive name from the last segment of cwd, capitalised
      const dirName = ctx.cwd.split(/[\/\\]/).filter(Boolean).pop() || "Agent";
      const name = dirName.charAt(0).toUpperCase() + dirName.slice(1);

      // Use current session's provider, model, and thinking level as defaults
      const provider = (ctx as any).model?.provider || "anthropic";
      const model = (ctx as any).model?.id || "claude-sonnet-4-5";
      let thinkingLevel = "medium";
      try {
        thinkingLevel = (pi as any).getThinkingLevel?.() ?? "medium";
      } catch { /* ignore */ }

      const template = [
        `name: "${name}"`,
        `provider: "${provider}"`,
        `model: "${model}"`,
        `thinkingLevel: "${thinkingLevel}"`,
        'description: ""',
        'systemPrompt: ""',
        '',
      ].join("\n");

      writeFileSync(filePath, template, "utf-8");
      ctx.ui.notify(`Created persona.yaml at ${filePath}`, "info");
    },
  });

  // ── Non-capturing overlay toggles ─────────────────────────────
  //
  // All overlays are non-capturing: the user can type in the editor while
  // they're visible. Prefix key (Ctrl+T → letter) toggles focus.
  // Esc closes regardless of focus state.
  //
  let activeMamoruOverlay: MamoruOverlay | null = null;
  let activeRosterOverlay: RosterDetailOverlay | null = null;
  let activeTaskOverlay: TaskDetailOverlay | null = null;

  function toggleMamoruOverlay(ctx: any) {
    const mamoru = getMamoru();
    if (!mamoru) {
      ctx.ui.notify("Not connected to any team channel. Use /team-join first.", "error");
      return;
    }

    // If overlay exists, toggle focus/unfocus (cycle)
    if (activeMamoruOverlay) {
      activeMamoruOverlay.toggleFocus();
      return;
    }

    // Show new overlay (non-capturing — user can keep typing)
    ctx.ui.custom<void>(
      (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
        const overlay = new MamoruOverlay(
          () => mamoru.getEventLog(),
          theme,
          done,
          tui,
        );
        activeMamoruOverlay = overlay;
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          width: "34%",
          maxHeight: "100%",
          margin: 0,
          nonCapturing: true,
        },
        onHandle: (handle: any) => {
          if (activeMamoruOverlay) {
            activeMamoruOverlay.setHandle(handle, () => {
              activeMamoruOverlay = null;
            });
          }
        },
      },
    ).then(() => {
      // Overlay was closed (done() called)
      activeMamoruOverlay = null;
    });
  }

  function toggleRosterOverlay(ctx: any) {
    const mamoru = getMamoru();
    if (!mamoru) {
      ctx.ui.notify("Not connected to any team channel. Use /team-join first.", "error");
      return;
    }

    if (activeRosterOverlay) {
      activeRosterOverlay.toggleFocus();
      return;
    }

    ctx.ui.custom<void>(
      (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
        const overlay = new RosterDetailOverlay(
          () => mamoru.getRoster().getAll(),
          mamoru.getAgentName(),
          () => mamoru.getStatus(),
          theme,
          done,
          tui,
        );
        activeRosterOverlay = overlay;
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "60%",
          maxHeight: "100%",
          nonCapturing: true,
        },
        onHandle: (handle: any) => {
          if (activeRosterOverlay) {
            activeRosterOverlay.setHandle(handle, () => {
              activeRosterOverlay = null;
            });
          }
        },
      },
    ).then(() => {
      activeRosterOverlay = null;
    });
  }

  function toggleTaskOverlay(ctx: any) {
    const mamoru = getMamoru();
    if (!mamoru) {
      ctx.ui.notify("Not connected to any team channel. Use /team-join first.", "error");
      return;
    }

    if (activeTaskOverlay) {
      activeTaskOverlay.toggleFocus();
      return;
    }

    ctx.ui.custom<void>(
      (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
        const overlay = new TaskDetailOverlay(
          () => mamoru.getActiveTask(),
          () => mamoru.getOutboundTasks(),
          theme,
          done,
          tui,
        );
        activeTaskOverlay = overlay;
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "60%",
          maxHeight: "100%",
          nonCapturing: true,
        },
        onHandle: (handle: any) => {
          if (activeTaskOverlay) {
            activeTaskOverlay.setHandle(handle, () => {
              activeTaskOverlay = null;
            });
          }
        },
      },
    ).then(() => {
      activeTaskOverlay = null;
    });
  }

  // Expose actions for prefix key system
  (pi as any).__teammateActions = {
    toggleMamoru: (ctx: any) => toggleMamoruOverlay(ctx),
    toggleRoster: (ctx: any) => toggleRosterOverlay(ctx),
    toggleTask: (ctx: any) => toggleTaskOverlay(ctx),
    closeMamoru: (): boolean => {
      if (activeMamoruOverlay) {
        activeMamoruOverlay.close();
        activeMamoruOverlay = null;
        return true;
      }
      return false;
    },
    closeRoster: (): boolean => {
      if (activeRosterOverlay) {
        activeRosterOverlay.close();
        activeRosterOverlay = null;
        return true;
      }
      return false;
    },
    closeTask: (): boolean => {
      if (activeTaskOverlay) {
        activeTaskOverlay.close();
        activeTaskOverlay = null;
        return true;
      }
      return false;
    },
  };

  pi.registerCommand("mamoru", {
    description: "Toggle MAMORU event log overlay (Ctrl+T then m)",
    handler: async (_args, ctx) => {
      toggleMamoruOverlay(ctx);
    },
  });

  // ── /task-history <task_id> ─────────────────────────────────────
  pi.registerCommand("task-history", {
    description: "Show all messages for a task. Usage: /task-history <task_id>",
    getArgumentCompletions: makeArgumentCompletions(defineHint("task-history", {
        summary: "Usage: /task-history <task_id>",
        examples: [
          { value: "<task_id>", label: "<task_id>", description: "Numeric task ID to inspect" },
        ],
      })),
    handler: async (args, ctx) => {
      const mamoru = getMamoru();
      if (!mamoru) {
        ctx.ui.notify("Not connected to any team channel.", "error");
        return;
      }

      const taskId = parseInt(args.trim(), 10);
      if (isNaN(taskId)) {
        ctx.ui.notify("Usage: /task-history <task_id>", "error");
        return;
      }

      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath(mamoru.getChannel());
      const db = new Database(dbPath, { readonly: true });

      try {
        const rows = db
          .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY message_id ASC")
          .all(taskId) as MessageRow[];

        if (rows.length === 0) {
          ctx.ui.notify(`No messages found for task #${taskId}.`, "info");
          return;
        }

        const lines = rows.map((row) => {
          const payload = parsePayload(row.payload);
          const event = payload?.event ?? "?";
          const content = payload?.content ?? "(unparseable)";
          const to = row.to_agent ? ` → ${row.to_agent}` : "";
          return `#${row.message_id} [${formatTimestamp(row.created_at)}] ${row.from_agent}${to} (${event}): ${content}`;
        });

        ctx.ui.notify(`Task #${taskId} history (${rows.length} messages):\n${lines.join("\n")}`, "info");
      } finally {
        db.close();
      }
    },
  });

  return { hintRegistry };
}
