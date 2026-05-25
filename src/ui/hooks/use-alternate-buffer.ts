import { useEffect } from "react";

/**
 * Switches the terminal to the alternate screen buffer (used by vim, less, htop).
 * On cleanup, restores the normal buffer so scrollback isn't lost.
 */
export function useAlternateBuffer(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    process.stdout.write("\x1b[?1049h"); // Enter alternate screen
    process.stdout.write("\x1b[H"); // Move cursor to top
    return () => {
      process.stdout.write("\x1b[?1049l"); // Leave alternate screen
    };
  }, [enabled]);
}
