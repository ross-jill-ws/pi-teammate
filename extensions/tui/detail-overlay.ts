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
  private overlayHandle: any = null;
  private onClose: (() => void) | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private getRoster: () => RosterEntry[];
  private getSelfStatus: () => string;

  constructor(
    getRoster: (() => RosterEntry[]) | RosterEntry[],
    private selfName: string,
    selfStatusOrGetter: string | (() => string),
    private theme: Theme,
    private done: (result: void) => void,
    tui?: any,
  ) {
    this.tui = tui;
    // Support both static and dynamic data sources
    this.getRoster = typeof getRoster === "function" ? getRoster : () => getRoster;
    this.getSelfStatus = typeof selfStatusOrGetter === "function" ? selfStatusOrGetter : () => selfStatusOrGetter;

    // Auto-refresh for live updates
    this.animTimer = setInterval(() => {
      try { this.tui?.requestRender(); } catch {}
    }, 1000);
  }

  /** Set the overlay handle for focus/unfocus control */
  setHandle(handle: any, onClose: () => void): void {
    this.overlayHandle = handle;
    this.onClose = onClose;
  }

  /** Toggle focus on/off from external shortcut */
  toggleFocus(): void {
    if (this.overlayHandle) {
      if (this.overlayHandle.isFocused()) {
        this.overlayHandle.unfocus();
      } else {
        this.overlayHandle.focus();
      }
    }
  }

  /** Close the overlay entirely */
  close(): void {
    if (this.overlayHandle) {
      this.overlayHandle.hide();
    }
    this.onClose?.();
    this.done();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
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
    const selfStatus = this.getSelfStatus();
    const selfIcon = selfStatus === "available" ? "●" : selfStatus === "busy" ? "○" : "✖";
    contentLines.push(row(th.fg("text", ` ${selfIcon} ${this.selfName} (you) — ${selfStatus}`)));
    contentLines.push(divider());

    // Teammates
    const roster = this.getRoster();
    if (roster.length === 0) {
      contentLines.push(row(th.fg("muted", " No teammates online")));
    } else {
      for (const entry of roster) {
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
    const focusState = this.focused ? "[FOCUSED]" : "(live)";
    const hint = this.focused
      ? " ↑↓ scroll  Esc close  C-t r unfocus "
      : " C-t r focus  Esc close ";
    const dashBefore = Math.max(0, innerW - hint.length - focusState.length - 2);
    const footerLines = [
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", ` ${focusState}${hint}`) +
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

  dispose(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
  }

  private getMaxHeight(): number {
    const termRows = this.tui?.terminal?.rows ?? 50;
    return Math.max(10, Math.floor(termRows * 0.8));
  }

  private getViewportHeight(): number {
    const headerFooter = 4; // 3 header + 1 footer
    return Math.max(3, this.getMaxHeight() - headerFooter);
  }

  private getContentLineCount(): number {
    const roster = this.getRoster();
    if (roster.length === 0) return 3;
    return 2 + roster.length * 3;
  }
}

// ── Task Detail Overlay ─────────────────────────────────────────

export class TaskDetailOverlay implements Focusable {
  focused = false;
  private scrollOffset = 0;
  private tui: any;
  private overlayHandle: any = null;
  private onClose: (() => void) | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private getActiveTask: () => ActiveTask | null;
  private getOutboundTasks: () => Map<number, OutboundTask>;

  constructor(
    getActiveTask: (() => ActiveTask | null) | ActiveTask | null,
    getOutboundTasks: (() => Map<number, OutboundTask>) | Map<number, OutboundTask>,
    private theme: Theme,
    private done: (result: void) => void,
    tui?: any,
  ) {
    this.tui = tui;
    // Support both static and dynamic data sources
    this.getActiveTask = typeof getActiveTask === "function" ? getActiveTask : () => getActiveTask;
    this.getOutboundTasks = typeof getOutboundTasks === "function" ? getOutboundTasks : () => getOutboundTasks;

    // Auto-refresh for live updates (elapsed timers)
    this.animTimer = setInterval(() => {
      try { this.tui?.requestRender(); } catch {}
    }, 1000);
  }

  /** Set the overlay handle for focus/unfocus control */
  setHandle(handle: any, onClose: () => void): void {
    this.overlayHandle = handle;
    this.onClose = onClose;
  }

  /** Toggle focus on/off from external shortcut */
  toggleFocus(): void {
    if (this.overlayHandle) {
      if (this.overlayHandle.isFocused()) {
        this.overlayHandle.unfocus();
      } else {
        this.overlayHandle.focus();
      }
    }
  }

  /** Close the overlay entirely */
  close(): void {
    if (this.overlayHandle) {
      this.overlayHandle.hide();
    }
    this.onClose?.();
    this.done();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
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
    const activeTask = this.getActiveTask();
    contentLines.push(row(th.fg("accent", " ACTIVE TASK (working on)")));
    if (activeTask) {
      contentLines.push(row(th.fg("text", ` ⚡ Task #${activeTask.taskId}`)));
      contentLines.push(row(th.fg("muted", `     requester: ${activeTask.requesterSessionId}`)));
      contentLines.push(row(th.fg("muted", `     elapsed:   ${formatElapsed(activeTask.startedAt)}`)));
    } else {
      contentLines.push(row(th.fg("muted", " No active task")));
    }

    contentLines.push(divider());

    // Outbound tasks (requester side)
    const outboundTasks = this.getOutboundTasks();
    contentLines.push(row(th.fg("accent", " OUTBOUND TASKS (delegated)")));
    if (outboundTasks.size === 0) {
      contentLines.push(row(th.fg("muted", " No outbound tasks")));
    } else {
      for (const [, task] of outboundTasks) {
        contentLines.push(row(th.fg("text", ` → Task #${task.taskId}`)));
        contentLines.push(row(th.fg("muted", `     worker:     ${task.workerSessionId}`)));
        contentLines.push(row(th.fg("muted", `     sent:       ${formatElapsed(task.sentAt)} ago`)));
        contentLines.push(row(th.fg("muted", `     last event: ${formatElapsed(task.lastEventAt)} ago`)));
        contentLines.push(row(th.fg("muted", `     elapsed:    ${formatElapsed(task.sentAt)}`)));
      }
    }

    // ── Footer ────────────────────────────────────────────────────
    const focusState = this.focused ? "[FOCUSED]" : "(live)";
    const hint = this.focused
      ? " ↑↓ scroll  Esc close  C-t t unfocus "
      : " C-t t focus  Esc close ";
    const dashBefore = Math.max(0, innerW - hint.length - focusState.length - 2);
    const footerLines = [
      th.fg("border", "╰" + "─".repeat(dashBefore)) +
        th.fg("dim", ` ${focusState}${hint}`) +
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

  dispose(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
  }

  private getMaxHeight(): number {
    const termRows = this.tui?.terminal?.rows ?? 50;
    return Math.max(10, Math.floor(termRows * 0.8));
  }

  private getViewportHeight(): number {
    const headerFooter = 4; // 3 header + 1 footer
    return Math.max(3, this.getMaxHeight() - headerFooter);
  }

  private getContentLineCount(): number {
    const activeTask = this.getActiveTask();
    const outboundTasks = this.getOutboundTasks();
    const activeLines = activeTask ? 4 : 2;
    const dividerLine = 1;
    const outboundHeader = 1;
    const outboundContent = outboundTasks.size === 0
      ? 1
      : outboundTasks.size * 5;
    return activeLines + dividerLine + outboundHeader + outboundContent;
  }
}
