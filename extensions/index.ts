/**
 * pi-teammate extension entry point.
 *
 * Wires together MAMORU, tools, commands, and lifecycle hooks.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import Database from "better-sqlite3";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { initSchema } from "./schema.ts";
import { loadPersona } from "./persona.ts";
import { Mamoru } from "./mamoru.ts";
import { Roster } from "./roster.ts";
import { createSendMessageTool } from "./tools/send-message.ts";
import { registerCommands } from "./commands.ts";
import { DEFAULT_MAMORU_CONFIG } from "./types.ts";
import { setupPrefixKeys } from "./prefix-keys.ts";
import { getChannelDir, getDbPath, getTeammateDir, channelExists } from "./paths.ts";

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
  pi.registerFlag("team-new", {
    description: "Delete existing channel DB and start clean (use with --team-channel)",
    type: "boolean",
    default: false,
  });

  // ── Tools ───────────────────────────────────────────────────────
  const sendMessageTool = createSendMessageTool({
    getMamoru: () => mamoru,
    getDb: () => activeDb,
  });
  pi.registerTool(sendMessageTool);

  // Update send_message description when roster changes
  pi.events.on("teammate_roster_changed", (data: any) => {
    const newDesc = data.roster.buildToolDescription(data.selfSessionId);
    pi.registerTool({ ...sendMessageTool, description: newDesc });
  });

  // ── Bootstrap Helper ────────────────────────────────────────────
  function bootstrapMamoru(ctx: ExtensionContext, channel: string, agentName: string, forceNew?: boolean): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const channelDir = getChannelDir(channel);
    const dbPath = getDbPath(channel);

    // --team-new: delete entire channel directory and start clean
    if (forceNew && existsSync(channelDir)) {
      rmSync(channelDir, { recursive: true, force: true });
      console.log(`[teammate] Deleted existing channel: ${channelDir}`);
    }

    if (!channelExists(channel)) {
      mkdirSync(channelDir, { recursive: true });
      const tempDb = new Database(dbPath);
      initSchema(tempDb);
      tempDb.close();
      console.log(`[teammate] Created channel DB: ${dbPath}`);
    }

    // Create this teammate's detail directory
    const teammateDir = getTeammateDir(channel, sessionId);

    if (activeDb) {
      try { activeDb.close(); } catch {}
    }
    const db = new Database(dbPath);
    initSchema(db);
    activeDb = db;

    const persona = loadPersona(ctx.cwd);
    const roster = new Roster();

    mamoru = new Mamoru({
      db: activeDb,
      sessionId,
      agentName,
      channel,
      persona,
      pi,
      ctx,
      roster,
      config: DEFAULT_MAMORU_CONFIG,
      teammateDir,
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

  // ── Prefix Keys (Ctrl+T → m/r/t) + Esc to close ──────────
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
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleRoster) actions.toggleRoster(ctx);
        },
        t: () => {
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleTask) actions.toggleTask(ctx);
        },
      };
    },
    {
      onEsc: () => {
        // Close any open overlay (regardless of focus state)
        const actions = (pi as any).__teammateActions;
        if (actions?.closeRoster?.()) return true;
        if (actions?.closeTask?.()) return true;
        if (actions?.closeMamoru?.()) return true;
        return false;
      },
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

    const forceNew = pi.getFlag("team-new") as boolean | undefined;
    bootstrapMamoru(ctx, channel, agentName, forceNew || false);
    console.log(`[teammate] Joined "${channel}" as "${agentName}"${forceNew ? " (clean start)" : ""}`);
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
