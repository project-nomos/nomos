/**
 * Persistent bottom status line showing model, cost, context usage, and session info.
 * Inspired by Claude Code's StatusLine — debounced updates, responsive layout.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text } from "ink";

export interface StatusLineData {
  /** Current model name */
  model: string;
  /** Total cost in USD for this session */
  costUsd?: number;
  /** Input tokens used this session */
  inputTokens?: number;
  /** Output tokens used this session */
  outputTokens?: number;
  /** Context window usage as percentage (0-100) */
  contextPercent?: number;
  /** Number of turns (user messages) */
  turnCount?: number;
  /** Current working directory */
  cwd?: string;
  /** Session key (shortened) */
  sessionKey?: string;
  /** Permission mode */
  permissionMode?: string;
}

interface StatusLineProps {
  data: StatusLineData;
  /** Debounce interval in ms (default: 300) */
  debounceMs?: number;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace(/-2025\d{4}$/, "")
    .replace(/-2024\d{4}$/, "");
}

function StatusLineInner({ data, debounceMs = 300 }: StatusLineProps): React.ReactElement {
  const [displayData, setDisplayData] = useState(data);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(data);
  latestRef.current = data;

  const flush = useCallback(() => {
    setDisplayData(latestRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    if (!timerRef.current) {
      timerRef.current = setTimeout(flush, debounceMs);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [data, flush, debounceMs]);

  const termWidth = process.stdout.columns || 80;
  const d = displayData;

  // Build sections
  const sections: string[] = [];

  // Model
  sections.push(shortModel(d.model));

  // Permission mode
  if (d.permissionMode && d.permissionMode !== "default") {
    sections.push(d.permissionMode);
  }

  // Context usage
  if (d.contextPercent !== undefined) {
    sections.push(`ctx ${d.contextPercent}%`);
  }

  // Token usage
  if (d.inputTokens !== undefined || d.outputTokens !== undefined) {
    const inp = formatTokens(d.inputTokens ?? 0);
    const out = formatTokens(d.outputTokens ?? 0);
    sections.push(`↓${inp} ↑${out}`);
  }

  // Cost
  if (d.costUsd !== undefined && d.costUsd > 0) {
    sections.push(formatCost(d.costUsd));
  }

  // Turn count
  if (d.turnCount !== undefined && d.turnCount > 0) {
    sections.push(`${d.turnCount} turn${d.turnCount === 1 ? "" : "s"}`);
  }

  // CWD (right side)
  const cwd = (d.cwd ?? process.cwd()).replace(process.env.HOME || "", "~");

  // Responsive: drop sections from right if too wide
  const separator = " · ";
  let leftText = sections.join(separator);
  while (leftText.length + cwd.length + 4 > termWidth && sections.length > 1) {
    sections.pop();
    leftText = sections.join(separator);
  }

  const padding = Math.max(1, termWidth - leftText.length - cwd.length - 2);

  return (
    <Box>
      <Text backgroundColor="#313244" color="#6C7086">
        {" "}
        {leftText}
        {" ".repeat(padding)}
        {cwd}{" "}
      </Text>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineInner);
