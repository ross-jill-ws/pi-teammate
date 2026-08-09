// Pluggable LLM idle-state detector for MAMORU.
//
// pi-teammate uses ctx.isIdle() from its framework to decide whether to flip
// `available`↔`busy` on every poll tick. Claude Code exposes no such signal
// to an MCP server. Default AlwaysIdle leaves status tracking driven by the
// task lifecycle only (task_ack→busy, task_done/fail→available).

export interface IdleDetector {
  isIdle(): boolean
}

export class AlwaysIdle implements IdleDetector {
  isIdle(): boolean {
    return true
  }
}

export class FakeIdle implements IdleDetector {
  constructor(private idle = true) {}
  isIdle(): boolean {
    return this.idle
  }
  set(idle: boolean): void {
    this.idle = idle
  }
}
