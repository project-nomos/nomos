import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export function ThinkingIndicator(): React.ReactElement {
  return (
    <Box marginLeft={2}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text dimColor> Thinking...</Text>
    </Box>
  );
}
