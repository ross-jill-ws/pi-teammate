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
import { registerCommands, setupHintWatcher } from "./commands.ts";
import { DEFAULT_MAMORU_CONFIG } from "./types.ts";
import { setupPrefixKeys } from "./prefix-keys.ts";
import { getChannelDir, getDbPath, getTeammateDir, channelExists } from "./paths.ts";
import { setupTts } from "./tts.ts";

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(mins)}:${pad(secs)}`
    : `${mins}:${pad(secs)}`;
}

export default function (pi: ExtensionAPI) {
  let mamoru: Mamoru | null = null;
  let activeDb: Database.Database | null = null;
  let extensionCtx: ExtensionContext | null = null;
  let uptimeTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeHintWatcher: (() => void) | null = null;

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
  pi.registerFlag("team-audio", {
    description: "Force teammate audio on/off for this session (overrides ELEVENLABS_API_KEY)",
    type: "string",
  });

  // ── TTS ──────────────────────────────────────────────────────────
  const tts = setupTts(pi, () => activeDb);

  // ── Tools ───────────────────────────────────────────────────────
  const sendMessageTool = createSendMessageTool({
    getMamoru: () => mamoru,
    getDb: () => activeDb,
  });
  pi.registerTool(sendMessageTool);

  // The send_message tool is only useful while connected to a team channel.
  // Toggle its presence in the active tool set so the LLM never sees it when
  // MAMORU is inactive (before /team-join or after /team-leave).
  function activateSendMessageTool(): void {
    const active = pi.getActiveTools();
    if (!active.includes("send_message")) {
      pi.setActiveTools([...active, "send_message"]);
    }
  }

  function deactivateSendMessageTool(): void {
    const active = pi.getActiveTools();
    if (active.includes("send_message")) {
      pi.setActiveTools(active.filter((t) => t !== "send_message"));
    }
  }

  // Update send_message description when roster changes
  pi.events.on("teammate_roster_changed", (data: any) => {
    const newDesc = data.roster.buildToolDescription(data.selfSessionId);
    pi.registerTool({ ...sendMessageTool, description: newDesc });
  });

  // ── Uptime Footer Status ─────────────────────────────────────
  function startUptimeDisplay(ctx: ExtensionContext): void {
    stopUptimeDisplay(ctx);
    uptimeTimer = setInterval(() => {
      if (mamoru?.isActive()) {
        const channel = mamoru.getChannel();
        const uptime = formatUptime(mamoru.getUptimeMs());
        ctx.ui.setStatus("teammate", `${channel}: ${uptime}`);
      } else {
        ctx.ui.setStatus("teammate", "mamoru: inactive");
      }
    }, 1000);
  }

  function stopUptimeDisplay(ctx: ExtensionContext): void {
    if (uptimeTimer) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }
    ctx.ui.setStatus("teammate", "mamoru: inactive");
  }

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
    startUptimeDisplay(ctx);
    activateSendMessageTool();

    // Start TTS poller for this channel (no-op if TTS not enabled, or
    // if poller already running). This must happen before mamoru.start()
    // emits the agent_join broadcast — but mamoru.start() is synchronous
    // and the TTS poller picks up queued items on its next tick, so the
    // ordering is fine either way.
    tts?.onSessionStart(ctx, channel);
  }

  // ── Commands ────────────────────────────────────────────────────
  const { hintRegistry } = registerCommands(
    pi,
    () => mamoru,
    (m) => {
      mamoru = m;
      if (m === null) {
        // /team-leave just cleared MAMORU — hide send_message from the LLM.
        deactivateSendMessageTool();
      }
    },
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

  // Auto-bootstrap from CLI flags on session start, and apply persona config
  pi.on("session_start", async (_event, ctx) => {
    extensionCtx = ctx;

    // Show inactive status in footer until team is joined
    ctx.ui.setStatus("teammate", "mamoru: inactive");

    // Hide send_message from the LLM until a team is joined
    deactivateSendMessageTool();

    // Install the slash-command usage-hint watcher (fires ctx.ui.notify
    // whenever the editor text becomes "/team-... " or "/task-... ").
    if (unsubscribeHintWatcher) {
      unsubscribeHintWatcher();
      unsubscribeHintWatcher = null;
    }
    unsubscribeHintWatcher = setupHintWatcher(ctx, hintRegistry);

    // ── Apply persona provider/model/thinkingLevel on session start (also runs on /reload) ──
    try {
      const persona = loadPersona(ctx.cwd);
      if (persona) {
        if (persona.provider && persona.model) {
          const modelObj = ctx.modelRegistry.find(persona.provider, persona.model);
          if (modelObj) {
            const ok = await pi.setModel(modelObj);
            if (ok) {
              console.log(`[teammate] Applied persona model: ${persona.provider}/${persona.model}`);
            } else {
              ctx.ui.notify(`persona.yaml: no API key for ${persona.provider}/${persona.model}`, "warning");
            }
          } else {
            ctx.ui.notify(`persona.yaml: model "${persona.model}" not found for provider "${persona.provider}"`, "warning");
          }
        }
        if (persona.thinkingLevel) {
          try {
            pi.setThinkingLevel(persona.thinkingLevel);
            console.log(`[teammate] Applied persona thinkingLevel: ${persona.thinkingLevel}`);
          } catch (err: any) {
            ctx.ui.notify(`persona.yaml: failed to set thinkingLevel: ${err.message}`, "warning");
          }
        }
      }
    } catch (err: any) {
      ctx.ui.notify(`Failed to load persona.yaml: ${err.message}`, "warning");
    }

    // ── Auto-join team channel from CLI flags ──
    const channel = pi.getFlag("team-channel") as string | undefined;
    let agentName = pi.getFlag("agent-name") as string | undefined;

    // Fall back to persona name if --agent-name not provided
    if (!agentName) {
      try {
        const persona = loadPersona(ctx.cwd);
        if (persona?.name) {
          agentName = persona.name;
        }
      } catch {
        // persona already loaded above; ignore errors here
      }
    }

    if (!channel && !agentName) {
      // No team flags — still init TTS for /tts-test command
      tts?.onSessionStart(ctx, null);
      return;
    }

    if (!channel) {
      // agentName from persona but no channel — nothing to join
      tts?.onSessionStart(ctx, null);
      return;
    }

    if (!agentName) {
      ctx.ui.notify("--agent-name is required (or set 'name' in persona.yaml)", "error");
      tts?.onSessionStart(ctx, null);
      return;
    }

    const forceNew = pi.getFlag("team-new") as boolean | undefined;
    bootstrapMamoru(ctx, channel, agentName, forceNew || false);
    console.log(`[teammate] Joined "${channel}" as "${agentName}"${forceNew ? " (clean start)" : ""}`);
    // TTS poller is started inside bootstrapMamoru.
  });

  // Inject persona + task context into system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    // When mamoru is active, it handles persona + task additions
    if (mamoru) {
      return mamoru.buildSystemPromptAdditions(event.systemPrompt);
    }

    // When not in a team, still apply persona systemPrompt if present
    try {
      const persona = loadPersona(ctx.cwd);
      if (persona?.systemPrompt) {
        return { systemPrompt: event.systemPrompt + "\n\n" + persona.systemPrompt };
      }
    } catch {
      // Silently ignore — persona errors are already reported on session_start
    }
    return undefined;
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    tts?.onShutdown();
    if (uptimeTimer) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }
    if (unsubscribeHintWatcher) {
      unsubscribeHintWatcher();
      unsubscribeHintWatcher = null;
    }
    mamoru?.stop();
    mamoru = null;
    if (activeDb) {
      try { activeDb.close(); } catch {}
      activeDb = null;
    }
  });
}
