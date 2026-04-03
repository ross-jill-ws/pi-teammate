/**
 * pi-teammate extension entry point.
 *
 * Wires together MAMORU, tools, commands, and lifecycle hooks.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { initSchema } from "./schema.ts";
import { loadPersona } from "./persona.ts";
import { Mamoru } from "./mamoru.ts";
import { Roster } from "./roster.ts";
import { createDelegateTaskTool } from "./tools/delegate-task.ts";
import { createSendMessageTool } from "./tools/send-message.ts";
import { registerCommands } from "./commands.ts";
import { DEFAULT_MAMORU_CONFIG } from "./types.ts";
import { setupPrefixKeys } from "./prefix-keys.ts";
import { RosterDetailOverlay, TaskDetailOverlay } from "./tui/detail-overlay.ts";

const BASE_DIR = join(homedir(), ".pi", "pi-teammate");

function getDbPath(channelName: string): string {
  return join(BASE_DIR, `${channelName}.db`);
}

function openDb(channelName: string): Database.Database {
  const dbPath = getDbPath(channelName);
  const db = new Database(dbPath);
  initSchema(db);
  return db;
}

export default function (pi: ExtensionAPI) {
  let mamoru: Mamoru | null = null;
  let activeDb: Database.Database | null = null;
  let extensionCtx: ExtensionContext | null = null;

  // ── CLI Flags ───────────────────────────────────────────────────
  pi.registerFlag("team-channel", {
    description: "Auto-join a team channel on startup (requires --agent-name)",
    type: "string",
  });
  pi.registerFlag("agent-name", {
    description: "Agent name for team registration (requires --team-channel)",
    type: "string",
  });

  // ── Tools ───────────────────────────────────────────────────────
  const delegateTaskTool = createDelegateTaskTool({
    getMamoru: () => mamoru,
    getDb: () => activeDb,
  });
  pi.registerTool(delegateTaskTool);

  const sendMessageTool = createSendMessageTool({
    getMamoru: () => mamoru,
    getDb: () => activeDb,
  });
  pi.registerTool(sendMessageTool);

  // Update delegate_task description when roster changes
  pi.events.on("teammate_roster_changed", (data: any) => {
    const newDesc = data.roster.buildToolDescription(data.selfSessionId);
    pi.registerTool({ ...delegateTaskTool, description: newDesc });
  });

  // ── Bootstrap Helper ────────────────────────────────────────────
  function bootstrapMamoru(ctx: ExtensionContext, channel: string, agentName: string): void {
    const dbPath = getDbPath(channel);
    if (!existsSync(dbPath)) {
      mkdirSync(BASE_DIR, { recursive: true });
      const tempDb = new Database(dbPath);
      initSchema(tempDb);
      tempDb.close();
    }

    if (activeDb) {
      try { activeDb.close(); } catch {}
    }
    activeDb = openDb(channel);

    const persona = loadPersona(ctx.cwd);
    const roster = new Roster();

    mamoru = new Mamoru({
      db: activeDb,
      sessionId: ctx.sessionManager.getSessionId(),
      agentName,
      channel,
      persona,
      pi,
      ctx,
      roster,
      config: DEFAULT_MAMORU_CONFIG,
    });
    mamoru.start();
  }

  // ── Commands ────────────────────────────────────────────────────
  registerCommands(
    pi,
    () => mamoru,
    (m) => { mamoru = m; },
    () => extensionCtx,
    { bootstrapMamoru },
  );

  // ── Prefix Keys (Ctrl+T → m/r/t) ──────────────────────────
  setupPrefixKeys(
    pi,
    () => extensionCtx,
    () => {
      if (!mamoru || !extensionCtx) return null;
      const ctx = extensionCtx;
      return {
        m: () => {
          // Toggle MAMORU overlay (reuse the toggle from commands.ts)
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleMamoru) actions.toggleMamoru(ctx);
        },
        r: () => {
          // Show roster detail overlay
          const roster = mamoru!.getRoster().getAll();
          ctx.ui.custom<void>(
            (tui: any, theme: any, _kb: any, done: (result: void) => void) =>
              new RosterDetailOverlay(roster, mamoru!.getAgentName(), mamoru!.getStatus(), theme, done),
            { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
          );
        },
        t: () => {
          // Show task detail overlay
          ctx.ui.custom<void>(
            (tui: any, theme: any, _kb: any, done: (result: void) => void) =>
              new TaskDetailOverlay(mamoru!.getActiveTask(), mamoru!.getOutboundTasks(), theme, done),
            { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
          );
        },
      };
    },
  );

  // ── Lifecycle Hooks ─────────────────────────────────────────────

  // Auto-bootstrap from CLI flags on session start
  pi.on("session_start", async (_event, ctx) => {
    extensionCtx = ctx;

    const channel = pi.getFlag("team-channel") as string | undefined;
    const agentName = pi.getFlag("agent-name") as string | undefined;

    if (!channel && !agentName) return;

    if (!channel || !agentName) {
      ctx.ui.notify("--team-channel and --agent-name must be used together", "error");
      return;
    }

    bootstrapMamoru(ctx, channel, agentName);
    console.log(`[teammate] Joined "${channel}" as "${agentName}"`);
  });

  // Inject persona + task context into system prompt
  pi.on("before_agent_start", async (event) => {
    if (!mamoru) return;
    return mamoru.buildSystemPromptAdditions(event.systemPrompt);
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    mamoru?.stop();
    mamoru = null;
    if (activeDb) {
      try { activeDb.close(); } catch {}
      activeDb = null;
    }
  });
}
