import { describe, test, expect } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { MamoruOverlay } from "../extensions/tui/mamoru-overlay.ts";
import type { MamoruEventLog } from "../extensions/mamoru.ts";

const theme = {
  fg: (_style: string, text: string) => text,
  bold: (text: string) => text,
};

describe("MamoruOverlay", () => {
  test("render keeps every line within the provided width", () => {
    const entries: MamoruEventLog[] = [
      {
        timestamp: Date.now(),
        direction: "recv",
        event: "task_update",
        otherParty: "Very Long Agent Name That Would Otherwise Overflow The Overlay",
        taskId: 123,
        content: "This is a long progress update that should be truncated cleanly by the overlay renderer.",
        forwardedToLlm: true,
      },
    ];

    const overlay = new MamoruOverlay(
      () => entries,
      theme as any,
      () => {},
      {
        terminal: { rows: 12 },
        requestRender: () => {},
      },
    );

    try {
      const lines = overlay.render(30);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(30);
      }
    } finally {
      overlay.dispose();
    }
  });
});
