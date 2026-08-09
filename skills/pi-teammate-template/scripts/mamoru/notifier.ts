// Pluggable outbound bridge for MAMORU.
//
// In pi-teammate, messages forwarded to the LLM go through
// `pi.sendUserMessage(text, { deliverAs: "steer" })`. We don't have that API in
// Claude Code — the only push surface is `notifications/claude/channel`.
//
// MAMORU calls `notifier.steer()` whenever the routing table says "forward to
// LLM". Step 00 ships a ConsoleNotifier default; step 01 will swap in an MCP
// notifier that emits channel notifications.

export interface Notifier {
  steer(content: string, meta?: Record<string, string>): void
}

export class ConsoleNotifier implements Notifier {
  steer(content: string, meta?: Record<string, string>): void {
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
    console.log(`[steer]${metaStr} ${content}`)
  }
}

export class RecordingNotifier implements Notifier {
  public calls: { content: string; meta?: Record<string, string> }[] = []
  steer(content: string, meta?: Record<string, string>): void {
    this.calls.push({ content, meta })
  }
  reset(): void {
    this.calls = []
  }
}
