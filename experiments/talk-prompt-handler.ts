/**
 * Fun chat mode — keeps a conversation going between two agents.
 *
 * Usage: /start-conversation <to_agent_session_id> <opening message>
 *
 * This sends an initial task_req via send_message. When the other agent
 * replies with task_done, this handler waits 2 seconds then sends another
 * task_req to keep the conversation going. The loop continues indefinitely.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let chatPartner: string | null = null; // session_id of the agent we're chatting with
  let active = false;

  pi.registerCommand("start-conversation", {
    description:
      "Start an endless chat with another agent. Usage: /start-conversation <to_agent_session_id> <opening message>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const toAgent = parts[0];
      const content = parts.slice(1).join(" ");

      if (!toAgent || !content) {
        ctx.ui.notify("Usage: /start-conversation <to_agent_session_id> <message>", "error");
        return;
      }

      chatPartner = toAgent;
      active = true;

      // Send opening message as task_req via the LLM's send_message tool isn't needed —
      // we can just tell the LLM to send it
      pi.sendUserMessage(
        `Send a task_req to agent "${toAgent}" with this message: ${content}`
      );

      ctx.ui.notify(`Conversation started with ${toAgent}.`, "info");
    },
  });

  pi.registerCommand("stop-conversation", {
    description: "Stop the ongoing chat conversation.",
    handler: async (_args, ctx) => {
      active = false;
      chatPartner = null;
      ctx.ui.notify("Conversation stopped.", "info");
    },
  });

  // Watch for task_done from our chat partner — send another message after 2s
  pi.on("agent_end", async (event, ctx) => {
    if (!active || !chatPartner) return;

    // Check if the last forwarded message was a task_done from our chat partner
    const messages = event.messages ?? [];

    // Look for a TEAM MESSAGE from the chat partner with task_done in the recent messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;

      const text = msg.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("");

      if (text.includes("task_done") && text.includes(chatPartner)) {
        // Wait 2 seconds then continue the conversation
        setTimeout(() => {
          if (!active || !chatPartner) return;
          pi.sendUserMessage(
            `Continue the conversation with agent "${chatPartner}". ` +
            `Send them another task_req with a natural follow-up message. ` +
            `Be conversational — ask a question, share a thought, or respond to what they said. ` +
            `Keep it concise and fun.`
          );
        }, 2000);
        return;
      }
    }
  });
}
