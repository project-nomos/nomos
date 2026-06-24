/**
 * Robustly pull the FIRST complete JSON value out of an LLM response.
 *
 * Why this exists: forked-agent concatenates the model's assistant text AND the
 * result message, so a one-shot JSON answer arrives DUPLICATED (often wrapped in
 * ```json fences too). A greedy `/\{[\s\S]*\}/` then matches first-`{` to last-`}`,
 * splicing the two copies (+ the fence junk between) into invalid JSON, so
 * JSON.parse throws and the caller silently gets nothing. This scans for the first
 * `{`/`[`, brace-balances it (respecting strings/escapes), and returns the first
 * candidate that actually parses — tolerant of fences, prose, and duplication.
 */
export function extractFirstJson(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1));
          } catch {
            break; // not valid from this start; advance to the next bracket
          }
        }
      }
    }
  }
  return null;
}

/**
 * Coerce a value that may be a JSON string into the parsed value (for SDK
 * `structured_output`, which can arrive already-parsed OR as a JSON string).
 * Returns the input unchanged when it isn't a parseable string.
 */
export function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
