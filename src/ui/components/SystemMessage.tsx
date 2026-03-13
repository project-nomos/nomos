import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface SystemMessageProps {
  content: string;
}

export function SystemMessage({ content }: SystemMessageProps): React.ReactElement {
  return (
    <Box>
      <Text dimColor>
        {theme.symbol.system + " "}
        {content}
      </Text>
    </Box>
  );
}
