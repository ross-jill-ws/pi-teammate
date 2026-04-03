import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { sendMessage } from "../db.ts";
import { createPayload, MESSAGE_EVENTS, TASK_ID_REQUIRED_EVENTS, MAX_CONTENT_LENGTH } from "../types.ts";
import type { MessageEvent } from "../types.ts";
import type { Mamoru } from "../mamoru.ts";

export const SendMessageParams = Type.Object({
  to: Type.Optional(Type.String({ description: "session_id of recipient. Omit for broadcast." })),
  event: Type.String({ description: "Message event type (task_done, task_update, task_fail, task_clarify, broadcast, info_only, etc.)" }),
  task_id: Type.Optional(Type.Number({ description: "The originating task_req's message_id. Required for all task-related events." })),
  ref_message_id: Type.Optional(Type.Number({ description: "The specific message this replies to. Usually same as task_id." })),
  content: Type.String({ description: "Message content (max 500 chars)" }),
  detail: Type.Optional(Type.String({ description: "Absolute file path with detailed content" })),
  intent: Type.Optional(Type.String({ description: "Freeform intent hint" })),
});

export type SendMessageInput = Static<typeof SendMessageParams>;

export function createSendMessageTool(opts: {
  getMamoru: () => Mamoru | null;
  getDb: () => Database.Database | null;
}) {
  return {
    name: "send_message",
    label: "Send Team Message",
    description:
      "Send a message to a teammate or broadcast to the team. Use for task_done, task_fail, task_update, task_clarify, broadcast, info_only.",
    parameters: SendMessageParams,
    async execute(
      toolCallId: string,
      params: SendMessageInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      const mamoru = opts.getMamoru();
      const db = opts.getDb();
      if (!mamoru || !db) throw new Error("Not connected to a team. Use /team-join first.");

      // Validate event
      if (!MESSAGE_EVENTS.includes(params.event as MessageEvent)) {
        throw new Error(
          `Unknown event "${params.event}". Must be one of: ${MESSAGE_EVENTS.join(", ")}`,
        );
      }

      // Validate task_id required for task-related events
      if (
        TASK_ID_REQUIRED_EVENTS.includes(params.event as MessageEvent) &&
        (params.task_id === undefined || params.task_id === null)
      ) {
        throw new Error(
          `Event "${params.event}" requires a task_id.`,
        );
      }

      // Validate content length
      if (params.content.length > MAX_CONTENT_LENGTH) {
        throw new Error(`Content exceeds ${MAX_CONTENT_LENGTH} characters.`);
      }

      const payload = createPayload(params.event as MessageEvent, params.content, {
        intent: params.intent ?? null,
        need_reply: false,
        detail: params.detail ?? null,
      });

      const messageId = sendMessage(db, {
        from_agent: mamoru.getSessionId(),
        to_agent: params.to ?? null,
        channel: mamoru.getChannel(),
        task_id: params.task_id ?? null,
        ref_message_id: params.ref_message_id ?? null,
        payload: JSON.stringify(payload),
      });

      // Let MAMORU handle outbound status transitions
      mamoru.handleOutbound(params.event, params.task_id);

      const target = params.to ? `"${params.to}"` : "broadcast";
      return {
        content: [
          {
            type: "text" as const,
            text: `Message #${messageId} (${params.event}) sent to ${target}.`,
          },
        ],
        details: { messageId, event: params.event, to: params.to ?? null },
      };
    },
  };
}
