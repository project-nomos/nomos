/**
 * Token estimation utilities.
 *
 * Provides rough token count estimation for text content, messages,
 * and various content block types. Adapted from Claude Code's
 * tokenEstimation.ts — simplified to use heuristic estimation
 * (no API-based counting) since nomos wraps the SDK which handles
 * precise token counting internally.
 */

/** Default bytes-per-token ratio for most text. */
const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Rough token count estimation based on character length.
 * Uses ~4 chars per token as a reasonable average for English text + code.
 */
export function roughTokenCount(content: string, bytesPerToken = DEFAULT_BYTES_PER_TOKEN): number {
  return Math.ceil(content.length / bytesPerToken);
}

/**
 * Returns a more accurate bytes-per-token ratio for known file types.
 * Dense formats like JSON have many single-character tokens.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    case "xml":
    case "html":
    case "svg":
      return 3;
    default:
      return DEFAULT_BYTES_PER_TOKEN;
  }
}

/**
 * Rough token count estimation with file-type-aware ratio.
 */
export function roughTokenCountForFileType(content: string, fileExtension: string): number {
  return roughTokenCount(content, bytesPerTokenForFileType(fileExtension));
}

/** Content block types from the Anthropic API. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  input?: unknown;
  name?: string;
  content?: string | ContentBlock[];
}

/**
 * Estimate tokens for a single content block.
 */
export function roughTokenCountForBlock(block: string | ContentBlock): number {
  if (typeof block === "string") {
    return roughTokenCount(block);
  }

  switch (block.type) {
    case "text":
      return roughTokenCount(block.text ?? "");

    case "thinking":
      return roughTokenCount(block.thinking ?? "");

    case "redacted_thinking":
      return roughTokenCount(block.data ?? "");

    case "image":
    case "document":
      // Images/PDFs: use conservative estimate matching Claude's vision pricing
      // tokens ≈ (width × height) / 750, max ~5333 for 2000×2000
      return 2000;

    case "tool_use":
      return roughTokenCount((block.name ?? "") + JSON.stringify(block.input ?? {}));

    case "tool_result":
      return roughTokenCountForContent(block.content);

    default:
      // Catch-all: stringify the block
      return roughTokenCount(JSON.stringify(block));
  }
}

/**
 * Estimate tokens for content (string or array of blocks).
 */
export function roughTokenCountForContent(content: string | ContentBlock[] | undefined): number {
  if (!content) return 0;
  if (typeof content === "string") return roughTokenCount(content);

  let total = 0;
  for (const block of content) {
    total += roughTokenCountForBlock(block);
  }
  return total;
}

/**
 * Estimate tokens for an array of messages.
 */
export function roughTokenCountForMessages(
  messages: Array<{ role?: string; content?: string | ContentBlock[] }>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += roughTokenCountForContent(msg.content);
    // Add ~4 tokens per message for role/formatting overhead
    total += 4;
  }
  return total;
}

/**
 * Format a token count for display (e.g., "12.3K", "1.2M").
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}
