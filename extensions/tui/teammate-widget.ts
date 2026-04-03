/**
 * TeammateWidget — TUI widget that renders two side-by-side cards:
 *   Card 1: Team Roster (channel members + self)
 *   Card 2: Task Tracker (active task + outbound tasks)
 */
import type { Mamoru } from "../mamoru.ts";
import { renderCard, type CardTheme } from "./tui-draw.ts";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

const CARD_THEMES: CardTheme[] = [
  { bg: "\x1b[48;2;15;55;30m", br: "\x1b[38;2;50;185;100m" }, // green for roster
  { bg: "\x1b[48;2;20;30;75m", br: "\x1b[38;2;70;110;210m" }, // blue for tasks
];

const WIDGET_ANIMATION_INTERVAL_MS = 500;
const MAX_ROWS = 4; // max items per card before "show more"

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const elapsed = Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export class TeammateWidget {
  private tui: any;
  private theme: any;
  private mamoru: Mamoru;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private renderVersion = 0;
  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];

  constructor(tui: any, theme: any, mamoru: Mamoru) {
    this.tui = tui;
    this.theme = theme;
    this.mamoru = mamoru;
    // Start animation timer for elapsed counters
    this.animTimer = setInterval(() => {
      this.renderVersion++;
      try {
        this.tui.requestRender();
      } catch {}
    }, WIDGET_ANIMATION_INTERVAL_MS);
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.renderVersion === this.cachedVersion) {
      return this.cachedLines;
    }
    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;

    const gap = 1;
    const colWidth = Math.floor((width - gap) / 2);
    const th = this.theme;

    // ── Card 1: Team Roster ───────────────────────────────────────
    const roster = this.mamoru.getRoster().getAll();
    const selfName = this.mamoru.getAgentName();
    const selfStatus = this.mamoru.getStatus();
    const channel = this.mamoru.getChannel();

    const rosterLines: string[] = [];
    // Self first
    const selfIcon = selfStatus === "available" ? "●" : selfStatus === "busy" ? "○" : "✖";
    rosterLines.push(`${selfIcon} ${selfName} (you) — ${selfStatus}`);
    // Teammates (up to MAX_ROWS)
    for (const entry of roster.slice(0, MAX_ROWS)) {
      const icon = entry.status === "available" ? "●" : entry.status === "busy" ? "○" : "✖";
      rosterLines.push(`${icon} ${entry.agent_name} — ${entry.status}`);
    }
    const rosterExtra = Math.max(0, roster.length - MAX_ROWS);
    const rosterContent = rosterLines.join("\n");
    const rosterFooter =
      rosterExtra > 0
        ? `+${rosterExtra} more`
        : roster.length === 0
          ? "no teammates"
          : undefined;

    const card1 = renderCard({
      title: `team: ${channel}`,
      badge: "#1",
      content: rosterContent,
      footer: rosterFooter,
      footerRight: "Alt+1",
      colWidth,
      theme: th,
      cardTheme: CARD_THEMES[0],
    });

    // ── Card 2: Task Tracker ──────────────────────────────────────
    const activeTask = this.mamoru.getActiveTask();
    const outbound = this.mamoru.getOutboundTasks();
    const taskLines: string[] = [];

    if (activeTask) {
      taskLines.push(`⚡ working on task #${activeTask.taskId} — ${formatElapsed(activeTask.startedAt)}`);
    }
    let taskCount = activeTask ? 1 : 0;
    for (const [, task] of outbound) {
      if (taskCount >= MAX_ROWS) break;
      taskLines.push(`→ task #${task.taskId} → ${task.workerSessionId.slice(0, 8)}… — ${formatElapsed(task.sentAt)}`);
      taskCount++;
    }
    if (taskLines.length === 0) {
      taskLines.push("no active tasks");
    }
    const taskExtra = Math.max(0, outbound.size - MAX_ROWS + (activeTask ? 1 : 0));
    const taskContent = taskLines.join("\n");
    const taskFooter = taskExtra > 0 ? `+${taskExtra} more` : undefined;

    const card2 = renderCard({
      title: "tasks",
      badge: "#2",
      content: taskContent,
      footer: taskFooter,
      footerRight: "Alt+2",
      colWidth,
      theme: th,
      cardTheme: CARD_THEMES[1],
    });

    // ── Merge cards side by side ──────────────────────────────────
    const lines: string[] = [""];
    const height = Math.max(card1.length, card2.length);
    for (let i = 0; i < height; i++) {
      const left = card1[i] ?? " ".repeat(colWidth);
      const right = card2[i] ?? " ".repeat(colWidth);
      lines.push(left + " ".repeat(gap) + right);
    }

    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  dispose(): void {
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
  }
}
