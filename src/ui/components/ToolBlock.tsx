import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export interface ToolBlockProps {
  /** Tool name (e.g., "Read", "Bash", "Write") */
  name: string;
  /** Elapsed time string (e.g., "0.3s") */
  elapsed?: string;
  /** Execution status */
  status: "success" | "error" | "executing";
  /** Result summary */
  summary?: string;
}

function statusIcon(status: ToolBlockProps["status"]): { icon: string; color: string } {
  switch (status) {
    case "success":
      return { icon: theme.symbol.toolSuccess, color: theme.status.success };
    case "error":
      return { icon: theme.symbol.toolError, color: theme.status.error };
    case "executing":
      return { icon: theme.symbol.toolRunning, color: theme.status.warning };
  }
}

/**
 * Renders a tool execution block with Gemini-style rounded borders.
 */
export function ToolBlock({ name, elapsed, status, summary }: ToolBlockProps): React.ReactElement {
  const { icon, color } = statusIcon(status);
  const borderColor = status === "executing" ? theme.border.active : theme.border.default;
  const borderDimColor = status !== "executing";

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      borderDimColor={borderDimColor}
      flexDirection="column"
      paddingX={1}
    >
      <Box>
        <Text color={color}>{icon}</Text>
        <Text color={theme.text.link} bold>
          {" " + name}
        </Text>
        {elapsed && <Text dimColor>{" (" + elapsed + ")"}</Text>}
      </Box>
      {summary && (
        <Box paddingLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      )}
    </Box>
  );
}
