import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  /** Current model name */
  model: string;
  /** Number of messages in transcript */
  messageCount: number;
}

/**
 * Persistent status line at the bottom of the terminal.
 * Shows model and message count.
 */
export function StatusBar({ model, messageCount }: StatusBarProps): React.ReactElement {
  // Format model name — show short version if it's a claude model
  const shortModel = model.replace("claude-", "").replace("-20250514", "").replace("-20251001", "");

  const parts: string[] = [shortModel];

  if (messageCount > 0) {
    parts.push(messageCount + " msgs");
  }

  return (
    <Box>
      <Text dimColor>{parts.join(" · ")}</Text>
    </Box>
  );
}
