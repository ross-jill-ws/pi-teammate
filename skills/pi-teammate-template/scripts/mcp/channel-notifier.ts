// MCP-side Notifier. Bridges MAMORU's steer events onto the
// `notifications/claude/channel` push, which (per step-00 discovery) is the
// only model-visible notification path in Claude Code.

import type { Notifier } from '../mamoru/notifier.ts'

/** Minimal contract for the JSON-RPC sender we need — keeps tests cheap. */
export interface NotificationSender {
  notification(n: { method: string; params?: unknown }): void | Promise<void>
}

export class ChannelNotifier implements Notifier {
  constructor(private readonly sender: NotificationSender) {}

  steer(content: string, meta?: Record<string, string>): void {
    // Best-effort: MCP's notification() returns a promise but the Notifier
    // contract is sync. We don't await — the SDK queues writes internally.
    void this.sender.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: meta ?? {} },
    })
  }
}
