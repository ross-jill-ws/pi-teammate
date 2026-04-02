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

function extractLatestAssistantReply(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const text = msg.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) return text;
  }

  return "";
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

  pi.on("before_agent_start", async (event) => {
    if (!pendingReply) return;

    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `You are in a direct chat conversation with another agent named ${pendingReply.fromAgent}. ` +
        `Your next assistant message will be sent back to them as-is. ` +
        `Write exactly one natural chat reply. ` +
        `Requirements: ` +
        `1) answer their latest message directly, ` +
        `2) sound like a normal person in conversation, ` +
        `3) keep it concise unless detail is genuinely needed, ` +
        `4) if helpful, end with one natural follow-up question to keep the conversation going, ` +
        `5) do not include analysis, tool chatter, file paths, markdown framing, or labels like "Reply:".`
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!pendingReply) return;

    const reply = pendingReply;
    pendingReply = null;

    // Send only the latest assistant reply, not every assistant message from the run.
    const messages = event.messages ?? [];

    ctx.ui.setStatus("agent-talk-reply", `agent_end: ${messages.length} messages`);

    const responseText = extractLatestAssistantReply(messages);
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
