/**
 * MAMORU event log overlay — shows all events handled by the guardian process.
 *
 * Anchored to the right side (1/3 width, 100% height). Non-capturing by default
 * so the user can type in the editor while viewing events. Auto-scrolls to bottom.
 *
 * Opened via Ctrl+T then m, or /mamoru command.
 * When focused, supports vertical scrolling: ↑/↓/j/k, PageUp/PageDown, Home/End.
 * Esc closes the overlay. Ctrl+T then m toggles focus/close.
 */
import type { Focusable } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { MamoruEventLog } from "../mamoru.ts";

type Theme = {
  fg: (style: string, text: string) => string;
  bold: (text: string) => string;
  [key: string]: any;
};

// ── ANSI color helpers (direct escapes for custom colors) ───────
const RESET = "\x1b[0m";
const FG = {
  green: "\x1b[38;2;80;200;120m",
  red: "\x1b[38;2;220;80;80m",
  blue: "\x1b[38;2;100;150;255m",
  yellow: "\x1b[38;2;220;200;80m",
  cyan: "\x1b[38;2;80;200;220m",
  magenta: "\x1b[38;2;200;120;220m",
  orange: "\x1b[38;2;230;160;60m",
  dim: "\x1b[38;2;100;100;100m",
  white: "\x1b[38;2;200;200;200m",
  brightWhite: "\x1b[38;2;240;240;240m",
};

function colorize(color: string, text: string): string {
  return color + text + RESET;
}

function getEventColor(entry: MamoruEventLog): string {
  if (entry.direction === "recv") {
    // Received events — blue/cyan family
    switch (entry.event) {
      case "task_req": return FG.cyan;
      case "task_cancel": return FG.red;
      case "ping": return FG.dim;
      case "broadcast":
      case "info_only": return FG.magenta;
      default: return FG.blue;
    }
  } else {
    // Sent events
    switch (entry.event) {
      case "task_done": return FG.green;
      case "task_fail":
      case "task_reject": return FG.red;
      case "task_ack": return FG.green;
      case "task_cancel": return FG.orange;
      case "task_cancel_ack": return FG.yellow;
      case "task_update": return FG.yellow;
      case "task_clarify":
      case "task_clarify_res": return FG.cyan;
      case "pong": return FG.dim;
      case "broadcast": return FG.magenta;
      default: return FG.white;
    }
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ── Render a single log entry into lines ────────────────────────
function renderEntry(entry: MamoruEventLog, innerW: number): string[] {
  const color = getEventColor(entry);
  const dirArrow = entry.direction === "recv" ? "◀ RECV" : "▶ SENT";
  const dirColor = entry.direction === "recv" ? FG.blue : FG.yellow;
  const time = formatTime(entry.timestamp);

  const lines: string[] = [];

  // Line 1: direction + event + time
  const header = `${colorize(dirColor, dirArrow)} ${colorize(color, entry.event)}`;
  const timeStr = colorize(FG.dim, time);
  lines.push(` ${header}  ${timeStr}`);

  // Line 2: other party + task context
  const partyLabel = entry.direction === "recv" ? "from" : "  to";
  const partyLine = `   ${colorize(FG.dim, partyLabel + ":")} ${colorize(FG.brightWhite, entry.otherParty)}`;
  const taskPart = entry.taskId ? colorize(FG.dim, `  task #${entry.taskId}`) : "";
  lines.push(partyLine + taskPart);

  // Line 3: content (truncated)
  if (entry.content) {
    const maxContentW = innerW - 4;
    const truncated = entry.content.length > maxContentW
      ? entry.content.slice(0, maxContentW - 1) + "…"
      : entry.content;
    lines.push(`   ${colorize(FG.dim, truncated)}`);
  }

  // Line 4: LLM forwarded indicator
  if (entry.forwardedToLlm) {
    lines.push(`   ${colorize(FG.orange, "⚡ → LLM (steer)")}`);
  }

  // Separator
  lines.push(colorize(FG.dim, " " + "─".repeat(innerW - 1)));

  return lines;
}

// ── Overlay component ───────────────────────────────────────────
export class MamoruOverlay implements Focusable {
  focused = false;

  private scrollOffset = 0;
  private userScrolled = false; // true if user manually scrolled up
  private lastEntryCount = 0;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private tui: any;
  private overlayHandle: any = null;
  private onClose: (() => void) | null = null;

  constructor(
    private getEntries: () => MamoruEventLog[],
    private theme: Theme,
    private done: (result: void) => void,
    tui?: any,
  ) {
    this.tui = tui;
    // Auto-refresh every 500ms for live updates
    this.animTimer = setInterval(() => {
      const entries = this.getEntries();
      if (entries.length !== this.lastEntryCount) {
        this.lastEntryCount = entries.length;
        if (!this.userScrolled) {
          this.scrollOffset = Infinity; // auto-scroll to bottom
        }
        try { this.tui?.requestRender(); } catch {}
      }
    }, 500);
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

    const entries = this.getEntries();
    const totalRendered = this.countTotalLines(entries);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.userScrolled = true;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(totalRendered, this.scrollOffset + 1);
      // If scrolled back to bottom, re-enable auto-scroll
      if (this.scrollOffset >= totalRendered - 5) {
        this.userScrolled = false;
      }
    } else if (matchesKey(data, "pageup")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.userScrolled = true;
    } else if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.min(totalRendered, this.scrollOffset + 10);
      if (this.scrollOffset >= totalRendered - 5) {
        this.userScrolled = false;
      }
    } else if (matchesKey(data, "home") || data === "g") {
      this.scrollOffset = 0;
      this.userScrolled = true;
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollOffset = Infinity;
      this.userScrolled = false;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const entries = this.getEntries();
    this.lastEntryCount = entries.length;

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
    const emptyRow = () => row("");

    // ── Header ────────────────────────────────────────────────────
    const headerLines: string[] = [];
    headerLines.push(th.fg("border", "┌" + "─".repeat(innerW) + "┐"));
    headerLines.push(row(th.fg("accent", th.bold(" 守 MAMORU Event Log"))));

    const countText = `${entries.length} events`;
    const focusState = this.focused
      ? colorize(FG.green, " [FOCUSED]")
      : colorize(FG.dim, " (live)");
    const scrollHint = this.userScrolled && this.focused
      ? colorize(FG.yellow, " scrolled")
      : "";
    headerLines.push(row(` ${colorize(FG.dim, countText)}${focusState}${scrollHint}`));
    headerLines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

    // ── Footer ────────────────────────────────────────────────────
    const footerLines: string[] = [];
    const hint = this.focused
      ? " ↑↓ scroll  PgUp/PgDn  Esc close  C-t m unfocus "
      : " C-t m focus  Esc close ";
    const dashBefore = Math.max(0, innerW - hint.length);
    footerLines.push(
      th.fg("border", "└" + "─".repeat(dashBefore)) +
      th.fg("dim", hint) +
      th.fg("border", "┘"),
    );

    // ── Scrollbar ─────────────────────────────────────────────────
    // We'll render all entry lines, then viewport-slice them

    // Pre-render all entries into lines
    const allContentLines: string[] = [];
    if (entries.length === 0) {
      allContentLines.push(row(th.fg("muted", " No events yet. Waiting for messages...")));
      allContentLines.push(emptyRow());
    } else {
      for (const entry of entries) {
        const entryLines = renderEntry(entry, innerW);
        for (const line of entryLines) {
          allContentLines.push(row(line));
        }
      }
    }

    // Calculate viewport from actual terminal height
    const termRows = this.tui?.terminal?.rows ?? 50;
    const headerFooterLines = 5; // 4 header + 1 footer
    const viewportHeight = Math.max(5, termRows - headerFooterLines);
    const totalContent = allContentLines.length;

    // Clamp scroll offset
    const maxScroll = Math.max(0, totalContent - viewportHeight);
    if (this.scrollOffset === Infinity || this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }

    // Slice visible portion
    const visibleContent = allContentLines.slice(
      this.scrollOffset,
      this.scrollOffset + viewportHeight,
    );

    // Scrollbar indicator
    const scrollbarLines: string[] = [];
    if (totalContent > viewportHeight) {
      const scrollPercent = totalContent > 0 ? this.scrollOffset / maxScroll : 0;
      const thumbPos = Math.round(scrollPercent * (viewportHeight - 1));

      for (let i = 0; i < visibleContent.length; i++) {
        const isThumb = i === thumbPos;
        const scrollChar = isThumb ? "█" : "░";
        // Replace the last character of the border with scrollbar
        const line = visibleContent[i];
        // The line ends with border "│" — replace it
        const stripped = line.slice(0, -visibleWidth(th.fg("border", "│")));
        scrollbarLines.push(stripped + th.fg("dim", scrollChar));
      }
    } else {
      scrollbarLines.push(...visibleContent);
    }

    // Pad to fill viewport
    while (scrollbarLines.length < viewportHeight) {
      scrollbarLines.push(emptyRow());
    }

    return [...headerLines, ...scrollbarLines, ...footerLines];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
  }

  private countTotalLines(entries: MamoruEventLog[]): number {
    let count = 0;
    for (const entry of entries) {
      count += 3 + (entry.content ? 1 : 0) + (entry.forwardedToLlm ? 1 : 0) + 1; // +1 for separator
    }
    return count;
  }
}
