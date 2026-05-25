import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface ThinkingBlockProps {
  /** Thinking/reasoning content */
  content: string;
  /** Whether this is a live/streaming thinking block */
  live?: boolean;
  /** Whether the finalized block is expanded (toggle with Ctrl+T) */
  expanded?: boolean;
}

/**
 * Renders thinking/reasoning indicator (Claude Code-style).
 * - Live: "● Thinking ▾" with streaming content preview
 * - Finalized collapsed: "● Thinking ▸"
 * - Finalized expanded: "● Thinking ▾" with full content
 */
function ThinkingBlockInner({ content, live, expanded }: ThinkingBlockProps): React.ReactElement {
  if (live) {
    // Live: show streaming preview
    const displayContent = content.trim();
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.text.accent}>{"●  "}</Text>
          <Text dimColor italic>
            Thinking ▾
          </Text>
        </Box>
        {displayContent && (
          <Box marginLeft={3} paddingLeft={1}>
            <Text dimColor italic>
              {displayContent}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Finalized: collapsed or expanded
  if (!expanded) {
    return (
      <Box marginTop={1}>
        <Text color={theme.text.accent}>{"●  "}</Text>
        <Text dimColor italic>
          Thinking ▸
        </Text>
        <Text dimColor>{" (Tab to expand)"}</Text>
      </Box>
    );
  }

  // Expanded: show full content with left border
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.text.accent}>{"●  "}</Text>
        <Text dimColor italic>
          Thinking ▾
        </Text>
        <Text dimColor>{" (Tab to collapse)"}</Text>
      </Box>
      <Box
        marginLeft={3}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.border.default}
        borderDimColor
        paddingLeft={1}
        flexDirection="column"
      >
        <Text dimColor italic>
          {content}
        </Text>
      </Box>
    </Box>
  );
}

export const ThinkingBlock = React.memo(ThinkingBlockInner);
