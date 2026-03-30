import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import Database from "better-sqlite3";

interface TalkMessageEvent {
  message_id: number;
  from_agent: string;
  to_agent: string | null;
  channel: string;
  type: string;
  payload: string;
  created_at: number;
  updated_at: number | null;
  _dbPath: string;
  _selfSessionId: string;
  _selfAgentName: string;
}

interface PendingReply {
  fromAgent: string;
  channel: string;
  dbPath: string;
  selfSessionId: string;
  selfAgentName: string;
}

export default function (pi: ExtensionAPI) {
  let pendingReply: PendingReply | null = null;

  pi.events.on("pi_talk_message", (data: unknown) => {
    const row = data as TalkMessageEvent;
    if (row.type !== "prompt") return;

    let content: string | undefined;
    try {
      const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      content = parsed?.content;
    } catch {
      return;
    }

    if (!content) return;

    // Store reply context before sending the user message
    pendingReply = {
      fromAgent: row.from_agent,
      channel: row.channel,
      dbPath: row._dbPath,
      selfSessionId: row._selfSessionId,
      selfAgentName: row._selfAgentName,
    };

    pi.sendUserMessage(content);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!pendingReply) return;

    const reply = pendingReply;
    pendingReply = null;

    // Extract assistant text from the messages produced during this prompt
    const assistantTexts: string[] = [];
    const messages = event.messages ?? [];

    ctx.ui.setStatus("agent-talk-reply", `agent_end: ${messages.length} messages`);

    for (const msg of messages) {
      if ((msg as any).role === "assistant" && Array.isArray((msg as any).content)) {
        for (const block of (msg as any).content) {
          if (block.type === "text" && block.text) {
            assistantTexts.push(block.text);
          }
        }
      }
    }

    const responseText = assistantTexts.join("\n");
    if (!responseText) {
      ctx.ui.notify(
        `agent-talk-reply: No assistant text found in ${messages.length} messages (roles: ${messages.map((m: any) => m.role).join(", ")})`,
        "warning",
      );
      return;
    }

    // Insert reply message into the channel DB
    try {
      const db = new Database(reply.dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = OFF");

      const now = Date.now();
      db.prepare(
        `INSERT INTO messages (from_agent, to_agent, channel, type, payload, created_at, updated_at)
         VALUES (?, ?, ?, 'prompt', ?, ?, ?)`
      ).run(
        reply.selfSessionId,
        reply.fromAgent,
        reply.channel,
        JSON.stringify({ content: responseText }),
        now,
        now,
      );

      db.close();
      ctx.ui.notify(`Reply sent to ${reply.fromAgent}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`agent-talk-reply DB error: ${err.message}`, "error");
    }
  });
}
