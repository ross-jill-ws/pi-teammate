/**
 * tui-draw — Reusable TUI drawing primitives for pi extensions.
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

export interface CardTheme {
  bg: string;   // ANSI bg escape
  br: string;   // ANSI fg escape for borders
}

export interface RenderCardOptions {
  title: string;
  badge?: string;
  content?: string;
  footer?: string;
  footerRight?: string;
  colWidth: number;
  theme: {
    fg: (style: string, text: string) => string;
    bold: (text: string) => string;
    [key: string]: any;
  };
  cardTheme: CardTheme;
}

/**
 * Render a bordered card as an array of ANSI-styled lines.
 *
 * Each line is exactly `colWidth` visible characters wide (including borders).
 */
export function renderCard(opts: RenderCardOptions): string[] {
  const { title, badge, content, footer, colWidth, theme, cardTheme } = opts;
  const w = colWidth - 2; // inner width (minus left+right border)
  const { bg, br } = cardTheme;

  const bord = (s: string) => bg + br + s + BG_RESET + FG_RESET;

  const borderLine = (text: string) => {
    const visLen = visibleWidth(text);
    const pad = " ".repeat(Math.max(0, w - visLen));
    return bord("│") + bg + text + bg + pad + BG_RESET + bord("│");
  };

  /** Like borderLine but places a right-aligned badge before the right border */
  const borderLineWithBadge = (text: string, badgeText: string) => {
    const styledBadge = theme.fg("accent", theme.bold(badgeText));
    const badgeVisLen = visibleWidth(badgeText);
    const textVisLen = visibleWidth(text);
    const gap = Math.max(1, w - textVisLen - badgeVisLen);
    return bord("│") + bg + text + bg + " ".repeat(gap) + styledBadge + BG_RESET + bord("│");
  };

  const top = "┌" + "─".repeat(w) + "┐";
  const bot = "└" + "─".repeat(w) + "┘";

  const lines: string[] = [bord(top)];

  // Title line — with optional badge on the right
  const truncTitle = truncateToWidth(title, badge ? w - visibleWidth(badge) - 2 : w - 1);
  const styledTitle = theme.fg("accent", theme.bold(truncTitle));
  if (badge) {
    lines.push(borderLineWithBadge(" " + styledTitle, badge));
  } else {
    lines.push(borderLine(" " + styledTitle));
  }

  // Content (defaults to "ready" muted) — supports multi-line
  const contentText = content ?? "ready";
  for (const cLine of contentText.split("\n")) {
    const truncContent = truncateToWidth(cLine, w - 1);
    const styledContent = theme.fg("muted", truncContent);
    lines.push(borderLine(" " + styledContent));
  }

  // Optional footer — with optional right-aligned text
  if (footer !== undefined) {
    const { footerRight } = opts;
    if (footerRight) {
      const rightVis = visibleWidth(footerRight);
      const maxLeft = w - rightVis - 2; // 1 pad each side
      const truncFooter = truncateToWidth(footer, maxLeft);
      const styledLeft = theme.fg("muted", truncFooter);
      const styledRight = theme.fg("dim", footerRight);
      const leftVis = visibleWidth(truncFooter);
      const gap = Math.max(1, w - 1 - leftVis - rightVis);
      const combined = " " + styledLeft + " ".repeat(gap) + styledRight;
      lines.push(borderLine(combined));
    } else {
      const truncFooter = truncateToWidth(footer, w - 1);
      const styledFooter = theme.fg("muted", truncFooter);
      lines.push(borderLine(" " + styledFooter));
    }
  }

  lines.push(bord(bot));
  return lines;
}
