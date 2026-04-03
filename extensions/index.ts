import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import Database from "better-sqlite3";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_DIR = join(homedir(), ".pi", "pi-teammate");

interface MessageRow {
  message_id: number;
  from_agent: string;
  to_agent: string | null;
  channel: string;
  type: string;
  payload: string;
  created_at: number;
  updated_at: number | null;
}

function getDbPath(channelName: string): string {
  return join(BASE_DIR, `${channelName}.db`);
}

function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT,
      cwd TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'deactive')),
      last_heartbeat INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      channel TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('prompt', 'pause', 'continue', 'close')),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_cursors (
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_id INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, channel)
    );
  `);
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function listChannelNames(): string[] {
  if (!existsSync(BASE_DIR)) return [];

  return readdirSync(BASE_DIR)
    .filter((name) => name.endsWith(".db"))
    .map((name) => name.slice(0, -3))
    .sort((a, b) => a.localeCompare(b));
}

function listAgentNames(channelName: string): string[] {
  const dbPath = getDbPath(channelName);
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT agent_name
         FROM agents
         WHERE agent_name IS NOT NULL AND agent_name != ''
         ORDER BY agent_name`
      )
      .all() as Array<{ agent_name: string }>;

    return rows.map((row) => row.agent_name);
  } finally {
    db.close();
  }
}

function parseCommandArgs(prefix: string): { parts: string[]; hasTrailingSpace: boolean } {
  return {
    parts: prefix.trim().length > 0 ? prefix.trim().split(/\s+/) : [],
    hasTrailingSpace: /\s$/.test(prefix),
  };
}

function buildAutocompleteItems(
  values: string[],
  partial: string,
  toValue: (value: string) => string = (value) => value,
  description?: (value: string) => string,
): AutocompleteItem[] | null {
  const filtered = values.filter((value) => value.startsWith(partial));
  if (filtered.length === 0) return null;

  return filtered.map((value) => ({
    value: toValue(value),
    label: value,
    description: description?.(value),
  }));
}

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let activeDb: Database.Database | null = null;
  let activeChannel: string | null = null;
  let activeSessionId: string | null = null;
  let activeAgentName: string | null = null;
  let activeDbFileName: string | null = null;

  async function promptForChannel(ctx: ExtensionContext, title: string): Promise<string | null> {
    const channels = unique([activeChannel, ...listChannelNames()]);

    if (channels.length > 0) {
      const selected = await ctx.ui.select(title, channels);
      if (selected) return selected;
      return null;
    }

    const typed = await ctx.ui.input(title, activeChannel ?? ctx.sessionManager.getSessionId());
    const value = typed?.trim();
    return value || null;
  }

  async function promptForAgent(
    ctx: ExtensionContext,
    channelName: string,
    title: string,
  ): Promise<string | null> {
    const agents = listAgentNames(channelName).filter((name) => name !== activeAgentName);

    if (agents.length > 0) {
      const selected = await ctx.ui.select(title, agents);
      if (selected) return selected;
      return null;
    }

    const typed = await ctx.ui.input(title, "agent name");
    const value = typed?.trim();
    return value || null;
  }

  async function promptForMessage(ctx: ExtensionContext, title: string): Promise<string | null> {
    const typed = await ctx.ui.input(title, "type your message");
    const value = typed?.trim();
    return value || null;
  }

  // -------------------------------------------------------------------
  // /agent-talk-build <channelName>
  // -------------------------------------------------------------------
  pi.registerCommand("agent-talk-build", {
    description:
      "Create a new agent-talk SQLite channel DB. Usage: /agent-talk-build [channelName] (defaults to current session id)",
    getArgumentCompletions: (prefix) => {
      const partial = prefix.trim();
      const suggestions = unique([activeChannel, activeSessionId]);
      return buildAutocompleteItems(suggestions, partial, (value) => value, () => "suggested channel name");
    },
    handler: async (args, ctx) => {
      const channelName = args.trim() || ctx.sessionManager.getSessionId();

      mkdirSync(BASE_DIR, { recursive: true });

      const dbPath = getDbPath(channelName);
      if (existsSync(dbPath)) {
        ctx.ui.notify(`Error: "${channelName}.db" already exists at ${dbPath}`, "error");
        return;
      }

      const db = new Database(dbPath);
      try {
        initSchema(db);
      } finally {
        db.close();
      }

      ctx.ui.notify(`Created channel DB: ${dbPath}`, "info");
    },
  });

  // -------------------------------------------------------------------
  // /agent-talk-register channelName [agentName]
  // -------------------------------------------------------------------
  pi.registerCommand("agent-talk-register", {
    description:
      "Register this agent on a channel and start polling. Usage: /agent-talk-register <channelName> [agentName]",
    getArgumentCompletions: (prefix) => {
      const { parts, hasTrailingSpace } = parseCommandArgs(prefix);

      if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
        const partialChannel = parts[0] ?? "";
        const channels = unique([activeChannel, ...listChannelNames()]);
        return buildAutocompleteItems(channels, partialChannel, (value) => value, () => "channel");
      }

      if ((parts.length === 1 && hasTrailingSpace) || (parts.length === 2 && !hasTrailingSpace)) {
        const channelName = parts[0];
        const partialAgent = hasTrailingSpace ? "" : (parts[1] ?? "");
        const agents = unique([activeAgentName, activeSessionId]);
        return buildAutocompleteItems(
          agents,
          partialAgent,
          (value) => `${channelName} ${value}`,
          () => `agent name on ${channelName}`,
        );
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let channelName = parts[0];

      if (!channelName) {
        channelName = await promptForChannel(ctx, "Choose channel to register on");
        if (!channelName) return;
      }

      const agentName = parts[1] || ctx.sessionManager.getSessionId();
      const sessionId = ctx.sessionManager.getSessionId();

      const dbPath = getDbPath(channelName);
      if (!existsSync(dbPath)) {
        ctx.ui.notify(`Error: "${channelName}.db" does not exist. Run /agent-talk-build ${channelName} first.`, "error");
        return;
      }

      // Clean up any previous registration / polling
      stopPolling();

      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = OFF");

      // Register agent
      db.prepare(
        `INSERT INTO agents (session_id, agent_name, cwd, status, last_heartbeat)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT (session_id) DO UPDATE SET
           agent_name = excluded.agent_name,
           cwd = excluded.cwd,
           status = 'active',
           last_heartbeat = excluded.last_heartbeat`
      ).run(sessionId, agentName, ctx.cwd, Date.now());

      // Initialize cursor for this channel at 0 (see full history)
      db.prepare(
        `INSERT INTO agent_cursors (session_id, channel, last_read_id)
         VALUES (?, ?, 0)
         ON CONFLICT (session_id, channel) DO NOTHING`
      ).run(sessionId, channelName);

      activeDb = db;
      activeChannel = channelName;
      activeSessionId = sessionId;
      activeAgentName = agentName;
      activeDbFileName = `${channelName}.db`;

      ctx.ui.notify(`Registered as "${agentName}" on channel "${channelName}". Polling started.`, "info");

      // Show initial widget
      ctx.ui.setWidget("teammate", [`[${activeDbFileName}] No new message`]);

      // Start polling every 1 second
      startPolling(ctx);
    },
  });

  // -------------------------------------------------------------------
  // /agent-talk-to channelName agentName prompt
  // -------------------------------------------------------------------
  pi.registerCommand("agent-talk-to", {
    description:
      "Send a message to an agent. Usage: /agent-talk-to <channelName> <agentName> <prompt...>",
    getArgumentCompletions: (prefix) => {
      const { parts, hasTrailingSpace } = parseCommandArgs(prefix);

      if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
        const partialChannel = parts[0] ?? "";
        const channels = unique([activeChannel, ...listChannelNames()]);
        return buildAutocompleteItems(channels, partialChannel, (value) => value, (value) =>
          value === activeChannel ? "active channel" : "channel",
        );
      }

      if ((parts.length === 1 && hasTrailingSpace) || (parts.length === 2 && !hasTrailingSpace)) {
        const channelName = parts[0];
        const partialAgent = hasTrailingSpace ? "" : (parts[1] ?? "");
        const agents = listAgentNames(channelName).filter((name) => name !== activeAgentName);
        return buildAutocompleteItems(
          agents,
          partialAgent,
          (value) => `${channelName} ${value}`,
          () => `agent on ${channelName}`,
        );
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      let channelName = parts[0] || activeChannel || undefined;
      if (!channelName) {
        channelName = await promptForChannel(ctx, "Choose a channel");
        if (!channelName) return;
      }

      let agentName = parts[1];
      if (!agentName) {
        agentName = await promptForAgent(ctx, channelName, `Choose recipient on \"${channelName}\"`);
        if (!agentName) return;
      }

      let prompt = parts.length >= 3 ? parts.slice(2).join(" ") : "";
      if (!prompt) {
        prompt = (await promptForMessage(ctx, `Message to ${agentName}:`)) ?? "";
        if (!prompt) return;
      }

      const dbPath = getDbPath(channelName);
      if (!existsSync(dbPath)) {
        ctx.ui.notify(`Error: "${channelName}.db" does not exist.`, "error");
        return;
      }

      if (!activeSessionId || !activeAgentName) {
        ctx.ui.notify("Error: You must register first with /agent-talk-register", "error");
        return;
      }

      try {
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = OFF");

        // Verify sender is registered
        const row = db.prepare(
          `SELECT agent_name FROM agents WHERE session_id = ?`
        ).get(activeSessionId) as { agent_name: string } | undefined;

        if (!row) {
          db.close();
          ctx.ui.notify(`Error: Agent not found for session ${activeSessionId}. Register first.`, "error");
          return;
        }

        const now = Date.now();
        db.prepare(
          `INSERT INTO messages (from_agent, to_agent, channel, type, payload, created_at, updated_at)
           VALUES (?, ?, ?, 'prompt', ?, ?, ?)`
        ).run(row.agent_name, agentName, channelName, JSON.stringify({ content: prompt }), now, now);

        db.close();
        ctx.ui.notify(`Message sent to ${agentName} on channel "${channelName}"`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Error sending message: ${err.message}`, "error");
      }
    },
  });

  // -------------------------------------------------------------------
  // Tool: send_agent_message
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description:
      "Send a message to another agent via the shared SQLite message bus. " +
      "Requires prior registration with /agent-talk-register.",
    parameters: Type.Object({
      to_agent: Type.String({ description: "Name of the target agent" }),
      channel: Type.String({ description: "Channel name (matches the DB file name)" }),
      type: StringEnum(["prompt", "pause", "continue", "close"] as const, {
        description: "Message type",
      }),
      payload: Type.String({
        description: 'JSON payload, e.g. {"content": "Hello agent!"}',
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!activeSessionId || !activeAgentName) {
        throw new Error("Not registered. Run /agent-talk-register first.");
      }

      const dbPath = getDbPath(params.channel);
      if (!existsSync(dbPath)) {
        throw new Error(`Channel "${params.channel}" does not exist.`);
      }

      // Validate payload is valid JSON with content
      let parsed: any;
      try {
        parsed = JSON.parse(params.payload);
      } catch {
        throw new Error("payload must be valid JSON");
      }
      if (!parsed.content) {
        throw new Error('payload must contain a "content" field');
      }

      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = OFF");

      // Look up sender's agent_name
      const row = db.prepare(
        `SELECT agent_name FROM agents WHERE session_id = ?`
      ).get(activeSessionId) as { agent_name: string } | undefined;

      if (!row) {
        db.close();
        throw new Error(`Agent not found for session. Register first.`);
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO messages (from_agent, to_agent, channel, type, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(row.agent_name, params.to_agent, params.channel, params.type, params.payload, now, now);

      db.close();

      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to "${params.to_agent}" on channel "${params.channel}" (type: ${params.type})`,
          },
        ],
        details: {
          to_agent: params.to_agent,
          channel: params.channel,
          messageType: params.type,
        },
      };
    },
  });

  // -------------------------------------------------------------------
  // Polling logic
  // -------------------------------------------------------------------
  function startPolling(ctx: ExtensionContext) {
    pollTimer = setInterval(() => {
      if (!activeDb || !activeChannel || !activeSessionId) return;

      try {
        // Fetch unread messages: broadcast (to_agent IS NULL) or direct (to_agent = me)
        const rows = activeDb
          .prepare(
            `SELECT m.* FROM messages m
             LEFT JOIN agent_cursors ac
               ON ac.session_id = ? AND ac.channel = m.channel
             WHERE m.channel = ?
               AND m.message_id > COALESCE(ac.last_read_id, 0)
               AND m.from_agent != ?
               AND (m.to_agent IS NULL OR m.to_agent = ? OR m.to_agent = ?)
             ORDER BY m.message_id`
          )
          .all(activeSessionId, activeChannel, activeSessionId, activeSessionId, activeAgentName) as MessageRow[];

        if (rows.length === 0) {
          ctx.ui.setWidget("teammate", [`[${activeDbFileName}] No new message`]);
          return;
        }

        // Process each message
        let maxId = 0;

        for (const row of rows) {
          if (row.message_id > maxId) maxId = row.message_id;

          // Emit event so other extensions can listen
          pi.events.emit("pi_talk_message", {
            ...row,
            _dbPath: getDbPath(activeChannel!),
            _selfSessionId: activeSessionId,
            _selfAgentName: activeAgentName,
          });
        }

        ctx.ui.setWidget("teammate", [`[${activeDbFileName}] last message_id: ${maxId}`]);

        // Advance cursor
        if (maxId > 0) {
          activeDb!
            .prepare(
              `INSERT INTO agent_cursors (session_id, channel, last_read_id)
               VALUES (?, ?, ?)
               ON CONFLICT (session_id, channel)
               DO UPDATE SET last_read_id = excluded.last_read_id`
            )
            .run(activeSessionId, activeChannel, maxId);
        }

        // Update heartbeat
        activeDb!
          .prepare(`UPDATE agents SET last_heartbeat = ? WHERE session_id = ?`)
          .run(Date.now(), activeSessionId);
      } catch (err: any) {
        ctx.ui.setWidget("teammate", [`[${activeDbFileName}] Poll error: ${err.message}`]);
      }
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (activeDb) {
      try {
        // Mark agent as deactive before closing
        if (activeSessionId) {
          activeDb
            .prepare(`UPDATE agents SET status = 'deactive' WHERE session_id = ?`)
            .run(activeSessionId);
        }
        activeDb.close();
      } catch {
        // DB might already be closed
      }
      activeDb = null;
    }
    activeChannel = null;
    activeSessionId = null;
    activeAgentName = null;
    activeDbFileName = null;
  }

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    stopPolling();
  });
}
