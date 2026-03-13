export interface ChunkResult {
  text: string;
  startLine: number;
  endLine: number;
}

export interface ChunkOptions {
  maxChunkSize?: number;
  overlap?: number;
}

const DEFAULT_MAX_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

/**
 * Split text into chunks suitable for embedding.
 * Splits on paragraph boundaries when possible, falls back to line boundaries.
 */
export function chunkText(text: string, options?: ChunkOptions): ChunkResult[] {
  const maxChunkSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;

  if (text.length === 0) {
    return [];
  }

  // If the whole text fits in one chunk, return it directly
  if (text.length <= maxChunkSize) {
    const lineCount = text.split("\n").length;
    return [{ text, startLine: 1, endLine: lineCount }];
  }

  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];

  let currentChunk = "";
  let chunkStartLine = 1;
  let currentLine = 1;

  for (const line of lines) {
    const candidateLine = line + "\n";
    const isBlankLine = line.trim() === "";

    // If adding this line would exceed the chunk size
    if (currentChunk.length + candidateLine.length > maxChunkSize && currentChunk.length > 0) {
      // Save the current chunk
      chunks.push({
        text: currentChunk.trimEnd(),
        startLine: chunkStartLine,
        endLine: currentLine - 1,
      });

      // Calculate overlap: walk backwards from the end of the current chunk
      const overlapText = getOverlapText(currentChunk, overlap);
      const overlapLineCount = overlapText.split("\n").length - 1;
      currentChunk = overlapText + candidateLine;
      chunkStartLine = Math.max(1, currentLine - overlapLineCount);
    } else if (isBlankLine && currentChunk.length > maxChunkSize * 0.6) {
      // Break at paragraph boundary if we have a reasonable chunk
      currentChunk += candidateLine;
      chunks.push({
        text: currentChunk.trimEnd(),
        startLine: chunkStartLine,
        endLine: currentLine,
      });

      const overlapText = getOverlapText(currentChunk, overlap);
      const overlapLineCount = overlapText.split("\n").length - 1;
      currentChunk = overlapText;
      chunkStartLine = Math.max(1, currentLine + 1 - overlapLineCount);
    } else {
      currentChunk += candidateLine;
    }

    currentLine++;
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      text: currentChunk.trimEnd(),
      startLine: chunkStartLine,
      endLine: currentLine - 1,
    });
  }

  return chunks;
}

/**
 * Get the last `maxOverlap` characters of text, breaking at a line boundary.
 */
function getOverlapText(text: string, maxOverlap: number): string {
  if (text.length <= maxOverlap) {
    return text;
  }
  const tail = text.slice(-maxOverlap);
  const newlineIdx = tail.indexOf("\n");
  if (newlineIdx >= 0) {
    return tail.slice(newlineIdx + 1);
  }
  return tail;
}
