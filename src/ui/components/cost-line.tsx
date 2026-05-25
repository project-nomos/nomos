import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface CostLineProps {
  content: string;
}

/**
 * Renders response metadata after completion (OpenCode-style).
 * Shows: ▣ tokens info
 */
function CostLineInner({ content }: CostLineProps): React.ReactElement {
  return (
    <Box paddingLeft={3}>
      <Text color={theme.text.accent}>▣ </Text>
      <Text dimColor>{content}</Text>
    </Box>
  );
}

export const CostLine = React.memo(CostLineInner);
