import stripAnsi from "strip-ansi";
import { stripVTControlCharacters } from "node:util";

/**
 * Strip unsafe characters from model output to prevent terminal corruption.
 * Removes ANSI escape codes, VT control sequences, BiDi overrides,
 * zero-width characters, and C0/C1 control chars (except TAB, LF, CR).
 */
export function stripUnsafeCharacters(text: string): string {
  const noAnsi = stripAnsi(text);
  const noVT = stripVTControlCharacters(noAnsi);
  // Remove C0 control chars (except TAB \x09, LF \x0A, CR \x0D),
  // C1 control chars, BiDi overrides, zero-width chars
  return noVT.replace(
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/g,
    "",
  );
}
