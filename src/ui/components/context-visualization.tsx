/**
 * Context visualization — shows token budget breakdown in the CLI.
 *
 * Renders a bar chart showing how the context window is being used:
 * system prompt, conversation, tools, and remaining capacity.
 * Triggered via /context slash command.
 *
 * Adapted from Claude Code's ContextVisualization.tsx.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export interface ContextSection {
  label: string;
  tokens: number;
  color: string;
}

export interface ContextVisualizationProps {
  /** Total context window size in tokens. */
  contextWindow: number;
  /** Sections of the context being used. */
  sections: ContextSection[];
  /** Whether to show detailed breakdown. */
  detailed?: boolean;
}

/** Bar width in characters. */
const BAR_WIDTH = 50;

function ContextVisualizationInner({
  contextWindow,
  sections,
  detailed = false,
}: ContextVisualizationProps): React.ReactElement {
  const totalUsed = sections.reduce((sum, s) => sum + s.tokens, 0);
  const remaining = Math.max(0, contextWindow - totalUsed);
  const usagePercent = Math.round((totalUsed / contextWindow) * 100);

  // Build the bar segments
  const barSegments: Array<{ char: string; color: string }> = [];
  for (const section of sections) {
    const width = Math.max(1, Math.round((section.tokens / contextWindow) * BAR_WIDTH));
    for (let i = 0; i < width && barSegments.length < BAR_WIDTH; i++) {
      barSegments.push({ char: "█", color: section.color });
    }
  }
  // Fill remaining with dim dots
  while (barSegments.length < BAR_WIDTH) {
    barSegments.push({ char: "░", color: theme.text.secondary });
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold>Context Window Usage</Text>
      <Text dimColor>
        {formatTokens(totalUsed)} / {formatTokens(contextWindow)} tokens ({usagePercent}%)
      </Text>

      {/* Bar chart */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>[</Text>
        {barSegments.map((seg, i) => (
          <Text key={i} color={seg.color}>
            {seg.char}
          </Text>
        ))}
        <Text color={theme.text.secondary}>]</Text>
      </Box>

      {/* Legend */}
      <Box flexDirection="column" marginTop={1}>
        {sections.map((section) => (
          <Box key={section.label} gap={1}>
            <Text color={section.color}>██</Text>
            <Text>
              {section.label.padEnd(20)} {formatTokens(section.tokens).padStart(8)} (
              {Math.round((section.tokens / contextWindow) * 100)}%)
            </Text>
          </Box>
        ))}
        <Box gap={1}>
          <Text color={theme.text.secondary}>░░</Text>
          <Text>
            {"Available".padEnd(20)} {formatTokens(remaining).padStart(8)} (
            {Math.round((remaining / contextWindow) * 100)}%)
          </Text>
        </Box>
      </Box>

      {/* Warnings */}
      {usagePercent > 90 && (
        <Box marginTop={1}>
          <Text color={theme.status.error} bold>
            ⚠ Context is {usagePercent}% full — compaction may trigger soon
          </Text>
        </Box>
      )}
      {usagePercent > 75 && usagePercent <= 90 && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>Context is {usagePercent}% full</Text>
        </Box>
      )}

      {/* Detailed per-model breakdown */}
      {detailed && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>
            Model Context Limits:
          </Text>
          <Text dimColor> Haiku 4.5: 200K tokens</Text>
          <Text dimColor> Sonnet 4.6: 200K tokens</Text>
          <Text dimColor> Opus 4.6: 200K tokens</Text>
        </Box>
      )}
    </Box>
  );
}

export const ContextVisualization = React.memo(ContextVisualizationInner);

/**
 * Build context sections from session data.
 */
export function buildContextSections(data: {
  systemPromptTokens: number;
  conversationTokens: number;
  toolSchemaTokens: number;
  memoryTokens?: number;
  skillsTokens?: number;
}): ContextSection[] {
  const sections: ContextSection[] = [
    { label: "System Prompt", tokens: data.systemPromptTokens, color: "#89b4fa" },
    { label: "Conversation", tokens: data.conversationTokens, color: "#a6e3a1" },
    { label: "Tool Schemas", tokens: data.toolSchemaTokens, color: "#f9e2af" },
  ];

  if (data.memoryTokens && data.memoryTokens > 0) {
    sections.push({ label: "Memory", tokens: data.memoryTokens, color: "#cba6f7" });
  }
  if (data.skillsTokens && data.skillsTokens > 0) {
    sections.push({ label: "Skills", tokens: data.skillsTokens, color: "#f38ba8" });
  }

  return sections;
}

// ── Helpers ──

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
