import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  /** Current model name */
  model: string;
  /** Number of messages in transcript */
  messageCount: number;
}

/**
 * Full-width status bar at the bottom of the terminal.
 * Styled like Gemini CLI: path | mode | model spread across the width.
 */
export function StatusBar({ model, messageCount }: StatusBarProps): React.ReactElement {
  // Format model name — show short version if it's a claude model
  const shortModel = model.replace("claude-", "").replace("-20250514", "").replace("-20251001", "");

  const cwd = process.cwd().replace(process.env.HOME || "", "~");
  const termWidth = process.stdout.columns || 80;

  // Build left, center, and right sections
  const left = ` ${cwd}`;
  const center = messageCount > 0 ? `${messageCount} msgs` : "";
  const right = `${shortModel} `;

  // Calculate padding to spread sections across the full width
  const separator = " \u2502 ";
  const contentLength = left.length + center.length + right.length + separator.length * 2;
  const remainingSpace = Math.max(0, termWidth - contentLength);
  const leftPad = Math.floor(remainingSpace / 2);
  const rightPad = remainingSpace - leftPad;

  return (
    <Box>
      <Text backgroundColor="#313244" color="#6C7086">
        {left}
        {" ".repeat(leftPad)}
        {separator}
        {center}
        {separator}
        {" ".repeat(rightPad)}
        {right}
      </Text>
    </Box>
  );
}
