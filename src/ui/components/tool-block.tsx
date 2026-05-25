import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
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

/**
 * Renders a tool execution block (Claude Code-style).
 * - Executing: "✳ Toolname..." with spinner
 * - Completed: "✓ Toolname (0.3s)" muted
 */
function ToolBlockInner({ name, elapsed, status, summary }: ToolBlockProps): React.ReactElement {
  if (status === "executing") {
    return (
      <Box marginTop={1}>
        <Text color={theme.status.warning}>
          <Spinner type="dots" />
        </Text>
        <Text dimColor>{"  " + name + "..."}</Text>
      </Box>
    );
  }

  const icon = status === "success" ? theme.symbol.toolSuccess : theme.symbol.toolError;
  const color = status === "success" ? theme.status.success : theme.status.error;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{icon + "  "}</Text>
        <Text dimColor>{name}</Text>
        {elapsed && <Text dimColor>{" (" + elapsed + ")"}</Text>}
      </Box>
      {summary && (
        <Box marginLeft={3} paddingLeft={1}>
          <Text dimColor>{summary}</Text>
        </Box>
      )}
    </Box>
  );
}

export const ToolBlock = React.memo(ToolBlockInner);
