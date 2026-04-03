import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { sendTaskReq } from "../db.ts";
import { createPayload, MAX_CONTENT_LENGTH } from "../types.ts";
import type { Roster } from "../roster.ts";
import type { Mamoru } from "../mamoru.ts";

export const DelegateTaskParams = Type.Object({
  to: Type.String({ description: "session_id of the target agent" }),
  task: Type.String({ description: "Task description (max 500 chars)" }),
  detail: Type.Optional(Type.String({ description: "Absolute file path with full task spec" })),
  intent: Type.Optional(Type.String({ description: "Freeform task type hint, e.g. 'code_review'" })),
});

export type DelegateTaskInput = Static<typeof DelegateTaskParams>;

export function createDelegateTaskTool(opts: {
  getMamoru: () => Mamoru | null;
  getDb: () => Database.Database | null;
}) {
  return {
    name: "delegate_task",
    label: "Delegate Task",
    description: "Assign a task to a teammate. No teammates are currently online.",
    parameters: DelegateTaskParams,
    async execute(
      toolCallId: string,
      params: DelegateTaskInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      const mamoru = opts.getMamoru();
      const db = opts.getDb();
      if (!mamoru || !db) throw new Error("Not connected to a team. Use /team-join first.");

      const roster = mamoru.getRoster();
      const target = roster.get(params.to);
      if (!target) throw new Error(`Agent "${params.to}" not found in roster.`);

      if (params.task.length > MAX_CONTENT_LENGTH) {
        throw new Error(`Task description exceeds ${MAX_CONTENT_LENGTH} characters.`);
      }

      const payload = createPayload("task_req", params.task, {
        intent: params.intent ?? null,
        need_reply: true,
        detail: params.detail ?? null,
      });

      const messageId = sendTaskReq(db, {
        from_agent: mamoru.getSessionId(),
        to_agent: params.to,
        channel: mamoru.getChannel(),
        payload: JSON.stringify(payload),
      });

      // Register outbound task for timeout tracking
      mamoru.registerOutboundTask(messageId, params.to);

      // Log outbound event
      mamoru.logOutbound("task_req", target.agent_name, messageId, params.task);

      return {
        content: [{ type: "text" as const, text: `Task #${messageId} sent to "${target.agent_name}". Waiting for acknowledgement.` }],
        details: { taskId: messageId, to: params.to, agentName: target.agent_name },
      };
    },
  };
}
