/**
 * Structured diff renderer with syntax highlighting and line numbers.
 * Renders unified diffs with colored added/removed lines.
 * Inspired by Claude Code's StructuredDiff with render caching.
 */

import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { theme } from "../theme.ts";

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

interface StructuredDiffProps {
  /** File path being diffed */
  filePath: string;
  /** Diff hunks to render */
  hunks: DiffHunk[];
  /** Whether to dim the entire diff (e.g., collapsed view) */
  dim?: boolean;
}

// Module-level render cache: WeakMap keyed by hunk object
const RENDER_CACHE = new WeakMap<DiffHunk, Map<string, string[]>>();
const MAX_CACHE_VARIANTS = 4;

function getCacheKey(width: number, dim: boolean): string {
  return `${width}|${dim ? 1 : 0}`;
}

function renderHunkLines(hunk: DiffHunk, width: number, dim: boolean): string[] {
  const cacheKey = getCacheKey(width, dim);

  let variantCache = RENDER_CACHE.get(hunk);
  if (variantCache) {
    const cached = variantCache.get(cacheKey);
    if (cached) return cached;
  }

  // Compute max line number width for gutter
  let maxLineNo = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.newLineNo && line.newLineNo > maxLineNo) maxLineNo = line.newLineNo;
    if (line.oldLineNo && line.oldLineNo > maxLineNo) maxLineNo = line.oldLineNo;
  }
  const gutterWidth = String(maxLineNo).length;

  const result: string[] = [];

  for (const line of hunk.lines) {
    const lineNo = (line.type === "remove" ? line.oldLineNo : line.newLineNo) ?? "";
    const gutter = String(lineNo).padStart(gutterWidth, " ");
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    const content = line.content;

    let formatted: string;
    if (line.type === "add") {
      const colorFn = dim ? chalk.dim.green : chalk.green;
      formatted = colorFn(`${gutter} ${marker} ${content}`);
    } else if (line.type === "remove") {
      const colorFn = dim ? chalk.dim.red : chalk.red;
      formatted = colorFn(`${gutter} ${marker} ${content}`);
    } else {
      const colorFn = dim ? chalk.dim : chalk.gray;
      formatted = colorFn(`${gutter} ${marker} ${content}`);
    }

    result.push(formatted);
  }

  // Cache the result
  if (!variantCache) {
    variantCache = new Map();
    RENDER_CACHE.set(hunk, variantCache);
  }
  if (variantCache.size >= MAX_CACHE_VARIANTS) {
    // Evict oldest
    const firstKey = variantCache.keys().next().value;
    if (firstKey) variantCache.delete(firstKey);
  }
  variantCache.set(cacheKey, result);

  return result;
}

function StructuredDiffInner({
  filePath,
  hunks,
  dim = false,
}: StructuredDiffProps): React.ReactElement {
  const width = process.stdout.columns || 80;

  return (
    <Box flexDirection="column">
      {/* File header */}
      <Text color={theme.text.link} dimColor={dim}>
        {"── " + filePath + " "}
        {"─".repeat(Math.max(0, width - filePath.length - 4))}
      </Text>

      {/* Hunks */}
      {hunks.map((hunk, hunkIdx) => {
        const lines = renderHunkLines(hunk, width, dim);
        return (
          <Box key={hunkIdx} flexDirection="column">
            <Text dimColor>
              @@ -{hunk.oldStart} +{hunk.newStart} @@
            </Text>
            {lines.map((line, lineIdx) => (
              <Text key={lineIdx}>{line}</Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export const StructuredDiff = React.memo(StructuredDiffInner);

/**
 * Parse a unified diff string into hunks.
 */
export function parseUnifiedDiff(diff: string): { filePath: string; hunks: DiffHunk[] } {
  const lines = diff.split("\n");
  let filePath = "";
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // File header
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      filePath = line.slice(4).replace(/^[ab]\//, "");
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        newLineNo: newLine++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "remove",
        content: line.slice(1),
        oldLineNo: oldLine++,
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNo: oldLine++,
        newLineNo: newLine++,
      });
    }
  }

  return { filePath, hunks };
}
