import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";
import { renderMarkdown } from "../markdown.ts";

interface NomosMessageProps {
  content: string;
}

export function NomosMessage({ content }: NomosMessageProps): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.text.accent}>{theme.symbol.nomos + " "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text>{renderMarkdown(content)}</Text>
      </Box>
    </Box>
  );
}
