/**
 * Detail overlays for pi-teammate TUI.
 *
 * RosterDetailOverlay — full team roster with descriptions.
 * TaskDetailOverlay   — active task + all outbound tasks with elapsed timers.
 *
 * Both implement Focusable, support vertical scrolling (↑/↓/j/k/PgUp/PgDn),
 * and close on Escape/Enter. They use tui.terminal.rows for pane-aware sizing.
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

// ── Scrollable overlay base ─────────────────────────────────────

function handleScroll(
  data: string,
  scrollOffset: number,
  totalContent: number,
  viewportHeight: number,
): { offset: number; handled: boolean } {
  const maxScroll = Math.max(0, totalContent - viewportHeight);

  if (matchesKey(data, "up") || matchesKey(data, "k")) {
    return { offset: Math.max(0, scrollOffset - 1), handled: true };
  }
  if (matchesKey(data, "down") || matchesKey(data, "j")) {
    return { offset: Math.min(maxScroll, scrollOffset + 1), handled: true };
  }
  if (matchesKey(data, "pageup")) {
    return { offset: Math.max(0, scrollOffset - 10), handled: true };
  }
  if (matchesKey(data, "pagedown")) {
    return { offset: Math.min(maxScroll, scrollOffset + 10), handled: true };
  }
  if (matchesKey(data, "home") || data === "g") {
    return { offset: 0, handled: true };
  }
  if (matchesKey(data, "end") || data === "G") {
    return { offset: maxScroll, handled: true };
  }

  return { offset: scrollOffset, handled: false };
}

function applyViewport(
  th: Theme,
  innerW: number,
  headerLines: string[],
  contentLines: string[],
  footerLines: string[],
  scrollOffset: number,
  maxViewportHeight: number,
): { lines: string[]; clampedOffset: number } {
  const headerFooterHeight = headerLines.length + footerLines.length;
  const viewportHeight = Math.max(3, maxViewportHeight - headerFooterHeight);
  const totalContent = contentLines.length;
  const maxScroll = Math.max(0, totalContent - viewportHeight);
  const clamped = Math.min(scrollOffset, maxScroll);

  const visible = contentLines.slice(clamped, clamped + viewportHeight);

  // Pad to fill viewport
  const emptyRow = makeRow(th, innerW, "");
  while (visible.length < viewportHeight) {
    visible.push(emptyRow);
  }

  return {
    lines: [...headerLines, ...visible, ...footerLines],
    clampedOffset: clamped,
  };
}

// ── Roster Detail Overlay ───────────────────────────────────────

export class RosterDetailOverlay implements Focusable {
  focused = false;
  private scrollOffset = 0;
  private tui: any;

  constructor(
    private roster: RosterEntry[],
    private selfName: string,
    private selfStatus: string,
    private theme: Theme,
    private done: (result: void) => void,
    tui?: any,
  ) {
    this.tui = tui;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
      return;
    }

    const result = handleScroll(data, this.scrollOffset, this.getContentLineCount(), this.getViewportHeight());
    if (result.handled) {
      this.scrollOffset = result.offset;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const row = (content: string) => makeRow(th, innerW, content);
    const divider = () => makeDivider(th, innerW);

    // ── Header ────────────────────────────────────────────────────
    const headerLines: string[] = [];
    headerLines.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));
    headerLines.push(row(th.fg("accent", th.bold(" Team Roster"))));
    headerLines.push(divider());

    // ── Content ───────────────────────────────────────────────────
    const contentLines: string[] = [];

    // Self
    const selfIcon = this.selfStatus === "available" ? "●" : this.selfStatus === "busy" ? "○" : "✖";
    contentLines.push(row(th.fg("text", ` ${selfIcon} ${this.selfName} (you) — ${this.selfStatus}`)));
    contentLines.push(divider());

    // Teammates
    if (this.roster.length === 0) {
      contentLines.push(row(th.fg("muted", " No teammates online")));
    } else {
      for (const entry of this.roster) {
        const icon = entry.status === "available" ? "●" : entry.status === "busy" ? "○" : "✖";
        contentLines.push(row(th.fg("text", ` ${icon} ${entry.agent_name} — ${entry.status}`)));
        const desc = truncateToWidth(entry.description || "(no description)", innerW - 5);
        contentLines.push(row(th.fg("muted", `     ${desc}`)));
        const heartbeat = entry.last_heartbeat
          ? `last seen: ${formatElapsed(entry.last_heartbeat)} ago`
          : "no heartbeat";
        contentLines.push(row(th.fg("dim", `     ${heartbeat}`)));
      }
    }

    // ── Footer ────────────────────────────────────────────────────
    const hint = " ↑↓ scroll  Esc close ";
    const dashBefore = Math.max(0, innerW - hint.length);
    const footerLines = [
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", hint) +
        th.fg("border", "╯"),
    ];

    const { lines, clampedOffset } = applyViewport(
      th, innerW, headerLines, contentLines, footerLines,
      this.scrollOffset, this.getMaxHeight(),
    );
    this.scrollOffset = clampedOffset;
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}

  private getMaxHeight(): number {
    const termRows = this.tui?.terminal?.rows ?? 50;
    return Math.max(10, Math.floor(termRows * 0.8));
  }

  private getViewportHeight(): number {
    const headerFooter = 4; // 3 header + 1 footer
    return Math.max(3, this.getMaxHeight() - headerFooter);
  }

  private getContentLineCount(): number {
    // Self (1 line + divider) + teammates (3 lines each) or "no teammates" (1 line)
    if (this.roster.length === 0) return 3; // self + divider + "no teammates"
    return 2 + this.roster.length * 3;
  }
}

// ── Task Detail Overlay ─────────────────────────────────────────

export class TaskDetailOverlay implements Focusable {
  focused = false;
  private scrollOffset = 0;
  private tui: any;

  constructor(
    private activeTask: ActiveTask | null,
    private outboundTasks: Map<number, OutboundTask>,
    private theme: Theme,
    private done: (result: void) => void,
    tui?: any,
  ) {
    this.tui = tui;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done();
      return;
    }

    const contentCount = this.getContentLineCount();
    const result = handleScroll(data, this.scrollOffset, contentCount, this.getViewportHeight());
    if (result.handled) {
      this.scrollOffset = result.offset;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const row = (content: string) => makeRow(th, innerW, content);
    const divider = () => makeDivider(th, innerW);

    // ── Header ────────────────────────────────────────────────────
    const headerLines: string[] = [];
    headerLines.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));
    headerLines.push(row(th.fg("accent", th.bold(" Task Tracker"))));
    headerLines.push(divider());

    // ── Content ───────────────────────────────────────────────────
    const contentLines: string[] = [];

    // Active task (worker side)
    contentLines.push(row(th.fg("accent", " ACTIVE TASK (working on)")));
    if (this.activeTask) {
      const at = this.activeTask;
      contentLines.push(row(th.fg("text", ` ⚡ Task #${at.taskId}`)));
      contentLines.push(row(th.fg("muted", `     requester: ${at.requesterSessionId}`)));
      contentLines.push(row(th.fg("muted", `     elapsed:   ${formatElapsed(at.startedAt)}`)));
    } else {
      contentLines.push(row(th.fg("muted", " No active task")));
    }

    contentLines.push(divider());

    // Outbound tasks (requester side)
    contentLines.push(row(th.fg("accent", " OUTBOUND TASKS (delegated)")));
    if (this.outboundTasks.size === 0) {
      contentLines.push(row(th.fg("muted", " No outbound tasks")));
    } else {
      for (const [, task] of this.outboundTasks) {
        contentLines.push(row(th.fg("text", ` → Task #${task.taskId}`)));
        contentLines.push(row(th.fg("muted", `     worker:     ${task.workerSessionId}`)));
        contentLines.push(row(th.fg("muted", `     sent:       ${formatElapsed(task.sentAt)} ago`)));
        contentLines.push(row(th.fg("muted", `     last event: ${formatElapsed(task.lastEventAt)} ago`)));
        contentLines.push(row(th.fg("muted", `     elapsed:    ${formatElapsed(task.sentAt)}`)));
      }
    }

    // ── Footer ────────────────────────────────────────────────────
    const hint = " ↑↓ scroll  Esc close ";
    const dashBefore = Math.max(0, innerW - hint.length);
    const footerLines = [
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", hint) +
        th.fg("border", "╯"),
    ];

    const { lines, clampedOffset } = applyViewport(
      th, innerW, headerLines, contentLines, footerLines,
      this.scrollOffset, this.getMaxHeight(),
    );
    this.scrollOffset = clampedOffset;
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}

  private getMaxHeight(): number {
    const termRows = this.tui?.terminal?.rows ?? 50;
    return Math.max(10, Math.floor(termRows * 0.8));
  }

  private getViewportHeight(): number {
    const headerFooter = 4; // 3 header + 1 footer
    return Math.max(3, this.getMaxHeight() - headerFooter);
  }

  private getContentLineCount(): number {
    const activeLines = this.activeTask ? 4 : 2; // header + content
    const dividerLine = 1;
    const outboundHeader = 1;
    const outboundContent = this.outboundTasks.size === 0
      ? 1
      : this.outboundTasks.size * 5;
    return activeLines + dividerLine + outboundHeader + outboundContent;
  }
}
