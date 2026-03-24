import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export function CopyModeIndicator(): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={theme.status.warning} paddingX={1}>
      <Text color={theme.status.warning}>
        Copy Mode — select text with your terminal. Press Ctrl+S or Escape to exit.
      </Text>
    </Box>
  );
}
