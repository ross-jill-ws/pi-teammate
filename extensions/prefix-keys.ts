/**
 * Prefix key system for pi-teammate.
 *
 * Press Ctrl+T to enter prefix mode, then press a second key:
 *   m → MAMORU event log overlay
 *   r → roster detail overlay
 *   t → task detail overlay
 *
 * Timeout after 1.5 seconds cancels prefix mode.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";

const PREFIX_KEY = Key.ctrl("t");
const PREFIX_TIMEOUT_MS = 1500;

export interface PrefixKeyActions {
  m: () => void; // MAMORU overlay
  r: () => void; // roster overlay
  t: () => void; // task overlay
}

export interface PrefixKeyCallbacks {
  /** Called when Esc is pressed (to close overlays). Return true if handled. */
  onEsc?: () => boolean;
}

// Debounce period after entering prefix mode — skips key release events
// from the Ctrl+T press (Kitty keyboard protocol sends release events).
const DEBOUNCE_MS = 150;

export function setupPrefixKeys(
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null,
  getActions: () => PrefixKeyActions | null,
  callbacks?: PrefixKeyCallbacks,
): void {
  let prefixActive = false;
  let prefixActivatedAt = 0;
  let prefixTimer: ReturnType<typeof setTimeout> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.onTerminalInput((data: string) => {
      // Step 1: Detect prefix key (Ctrl+T)
      if (!prefixActive && matchesKey(data, PREFIX_KEY)) {
        prefixActive = true;
        prefixActivatedAt = Date.now();
        ctx.ui.setStatus("teammate-prefix", "Ctrl+T ▸ (m)amoru  (r)oster  (t)asks");

        // Auto-cancel after timeout
        if (prefixTimer) clearTimeout(prefixTimer);
        prefixTimer = setTimeout(() => {
          prefixActive = false;
          ctx.ui.setStatus("teammate-prefix", undefined);
          prefixTimer = null;
        }, PREFIX_TIMEOUT_MS);

        return { consume: true };
      }

      // Step 2: Handle second key in prefix mode
      if (prefixActive) {
        // Skip key release events from the Ctrl+T press (debounce)
        if (Date.now() - prefixActivatedAt < DEBOUNCE_MS) {
          return { consume: true };
        }

        prefixActive = false;
        if (prefixTimer) {
          clearTimeout(prefixTimer);
          prefixTimer = null;
        }
        ctx.ui.setStatus("teammate-prefix", undefined);

        const actions = getActions();
        if (!actions) {
          ctx.ui.notify("Not connected to a team channel. Use /team-join first.", "warning");
          return { consume: true };
        }

        const key = data.toLowerCase();
        if (key === "m") {
          actions.m();
          return { consume: true };
        } else if (key === "r") {
          actions.r();
          return { consume: true };
        } else if (key === "t") {
          actions.t();
          return { consume: true };
        }

        // Unknown key — cancel prefix, don't consume (let it through to editor)
        return undefined;
      }

      // Esc — close active overlay if callback handles it
      if (matchesKey(data, "escape")) {
        if (callbacks?.onEsc?.()) {
          return { consume: true };
        }
      }

      return undefined;
    });
  });
}
