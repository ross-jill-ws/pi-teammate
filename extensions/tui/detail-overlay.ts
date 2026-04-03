/**
 * Detail overlays for pi-teammate TUI.
 *
 * RosterDetailOverlay — full team roster with descriptions.
 * TaskDetailOverlay   — active task + all outbound tasks with elapsed timers.
 *
 * Both implement Focusable and close on Escape/Enter.
 */
import type { Focusable } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { RosterEntry, OutboundTask, ActiveTask } from "../types.ts";
import { formatElapsed } from "./teammate-widget.ts";

// ── Helpers ─────────────────────────────────────────────────────

type Theme = {
  fg: (style: string, text: string) => string;
  bold: (text: string) => string;
  [key: string]: any;
};

function pad(s: string, len: number): string {
  const vis = visibleWidth(s);
  return s + " ".repeat(Math.max(0, len - vis));
}

function makeRow(th: Theme, innerW: number, content: string): string {
  return th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
}

function makeDivider(th: Theme, innerW: number): string {
  return th.fg("border", "├" + "─".repeat(innerW) + "┤");
}

// ── Roster Detail Overlay ───────────────────────────────────────

export class RosterDetailOverlay implements Focusable {
  focused = false;

  constructor(
    private roster: RosterEntry[],
    private selfName: string,
    private selfStatus: string,
    private theme: Theme,
    private done: (result: void) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const row = (content: string) => makeRow(th, innerW, content);
    const divider = () => makeDivider(th, innerW);

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));

    // Header
    lines.push(row(th.fg("accent", th.bold(" Team Roster"))));
    lines.push(divider());

    // Self
    const selfIcon = this.selfStatus === "available" ? "●" : this.selfStatus === "busy" ? "○" : "✖";
    lines.push(row(th.fg("text", ` ${selfIcon} ${this.selfName} (you) — ${this.selfStatus}`)));
    lines.push(divider());

    // Teammates
    if (this.roster.length === 0) {
      lines.push(row(th.fg("muted", " No teammates online")));
    } else {
      for (const entry of this.roster) {
        const icon = entry.status === "available" ? "●" : entry.status === "busy" ? "○" : "✖";
        lines.push(row(th.fg("text", ` ${icon} ${entry.agent_name} — ${entry.status}`)));
        const desc = truncateToWidth(entry.description || "(no description)", innerW - 5);
        lines.push(row(th.fg("muted", `     ${desc}`)));
        const heartbeat = entry.last_heartbeat
          ? `last seen: ${formatElapsed(entry.last_heartbeat)} ago`
          : "no heartbeat";
        lines.push(row(th.fg("dim", `     ${heartbeat}`)));
      }
    }

    // Bottom border with hint
    const hint = " Esc ";
    const dashBefore = Math.max(0, innerW - hint.length);
    lines.push(
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", hint) +
        th.fg("border", "╯"),
    );

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ── Task Detail Overlay ─────────────────────────────────────────

export class TaskDetailOverlay implements Focusable {
  focused = false;

  constructor(
    private activeTask: ActiveTask | null,
    private outboundTasks: Map<number, OutboundTask>,
    private theme: Theme,
    private done: (result: void) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const row = (content: string) => makeRow(th, innerW, content);
    const divider = () => makeDivider(th, innerW);

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));

    // Header
    lines.push(row(th.fg("accent", th.bold(" Task Tracker"))));
    lines.push(divider());

    // ── Active task (worker side) ─────────────────────────────────
    lines.push(row(th.fg("accent", " ACTIVE TASK (working on)")));
    if (this.activeTask) {
      const at = this.activeTask;
      lines.push(row(th.fg("text", ` ⚡ Task #${at.taskId}`)));
      lines.push(row(th.fg("muted", `     requester: ${at.requesterSessionId}`)));
      lines.push(row(th.fg("muted", `     elapsed:   ${formatElapsed(at.startedAt)}`)));
    } else {
      lines.push(row(th.fg("muted", " No active task")));
    }

    lines.push(divider());

    // ── Outbound tasks (requester side) ───────────────────────────
    lines.push(row(th.fg("accent", " OUTBOUND TASKS (delegated)")));
    if (this.outboundTasks.size === 0) {
      lines.push(row(th.fg("muted", " No outbound tasks")));
    } else {
      for (const [, task] of this.outboundTasks) {
        lines.push(row(th.fg("text", ` → Task #${task.taskId}`)));
        lines.push(row(th.fg("muted", `     worker:     ${task.workerSessionId}`)));
        lines.push(row(th.fg("muted", `     sent:       ${formatElapsed(task.sentAt)} ago`)));
        lines.push(row(th.fg("muted", `     last event: ${formatElapsed(task.lastEventAt)} ago`)));
        lines.push(row(th.fg("muted", `     elapsed:    ${formatElapsed(task.sentAt)}`)));
      }
    }

    // Bottom border with hint
    const hint = " Esc ";
    const dashBefore = Math.max(0, innerW - hint.length);
    lines.push(
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", hint) +
        th.fg("border", "╯"),
    );

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
