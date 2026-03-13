/**
 * Smart response chunking for channel character limits.
 *
 * When a response exceeds a platform's character limit, this module
 * provides two strategies:
 *   1. For moderately long responses: split into multiple messages at natural boundaries
 *   2. For very long responses: send a truncated preview + full text as a file attachment
 *
 * Thresholds are per-platform:
 *   - Discord: 2000 chars
 *   - Slack: 4000 chars
 *   - Telegram: 4096 chars
 *   - Default: 4000 chars
 */

/** Platform-specific character limits. */
export const PLATFORM_LIMITS: Record<string, number> = {
  discord: 2000,
  slack: 4000,
  telegram: 4096,
  whatsapp: 65536,
  imessage: 20000,
};

const DEFAULT_LIMIT = 4000;

/** Threshold multiplier: if response exceeds limit * this, use file attachment strategy. */
const FILE_THRESHOLD_MULTIPLIER = 3;

export interface ChunkedResponse {
  /** Strategy used: "single" (fits), "chunks" (split), or "file" (too long, attach file). */
  strategy: "single" | "chunks" | "file";
  /** Text chunks to send as messages. */
  chunks: string[];
  /** Full response text for file attachment (only when strategy is "file"). */
  fullText?: string;
  /** Suggested filename (only when strategy is "file"). */
  filename?: string;
}

/**
 * Determine the best chunking strategy for a response on a given platform.
 */
export function chunkResponse(text: string, platform: string): ChunkedResponse {
  const limit = PLATFORM_LIMITS[platform] ?? DEFAULT_LIMIT;

  // Fits in a single message
  if (text.length <= limit) {
    return { strategy: "single", chunks: [text] };
  }

  // Very long response — use file attachment with truncated preview
  if (text.length > limit * FILE_THRESHOLD_MULTIPLIER) {
    const previewLimit = Math.floor(limit * 0.8);
    // Find a natural break point for the preview
    let breakIdx = text.lastIndexOf("\n\n", previewLimit);
    if (breakIdx < previewLimit / 2) breakIdx = text.lastIndexOf("\n", previewLimit);
    if (breakIdx < previewLimit / 2) breakIdx = text.lastIndexOf(" ", previewLimit);
    if (breakIdx < previewLimit / 2) breakIdx = previewLimit;

    const preview = text.slice(0, breakIdx).trimEnd();
    const truncationNote = `\n\n_Response was ${text.length.toLocaleString()} characters. Full response attached as file._`;

    return {
      strategy: "file",
      chunks: [preview + truncationNote],
      fullText: text,
      filename: `response-${Date.now()}.md`,
    };
  }

  // Moderate length — split into chunks at natural boundaries
  return { strategy: "chunks", chunks: splitAtBoundaries(text, limit) };
}

/**
 * Split text into chunks at natural boundaries (paragraphs, lines, spaces).
 */
function splitAtBoundaries(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at paragraph, then line, then space, then hard cut
    let idx = remaining.lastIndexOf("\n\n", maxLength);
    if (idx < maxLength / 2) idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength / 2) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx < maxLength / 2) idx = maxLength;

    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }

  return chunks;
}
