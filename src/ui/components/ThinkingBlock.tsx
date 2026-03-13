import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface ThinkingBlockProps {
  /** Thinking/reasoning content */
  content: string;
}

/**
 * Renders thinking/reasoning content with a left border (Gemini-style).
 */
export function ThinkingBlock({ content }: ThinkingBlockProps): React.ReactElement {
  // Truncate long content
  const maxLen = 300;
  const displayContent = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;

  return (
    <Box
      marginLeft={2}
      borderStyle="single"
      borderLeft={true}
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={theme.border.default}
      paddingLeft={1}
      flexDirection="column"
    >
      <Text color={theme.text.secondary} italic>
        {displayContent}
      </Text>
    </Box>
  );
}
