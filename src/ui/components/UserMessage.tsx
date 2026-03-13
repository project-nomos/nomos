import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.text.user} bold>
        {theme.symbol.user + " "}
      </Text>
      <Text>{content}</Text>
    </Box>
  );
}
