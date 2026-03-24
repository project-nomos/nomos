import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";
import { MarkdownDisplay } from "./MarkdownDisplay.tsx";

interface NomosMessageProps {
  content: string;
}

function NomosMessageInner({ content }: NomosMessageProps): React.ReactElement {
  // Reserve 3 columns for the "●  " prefix
  const width = Math.min((process.stdout.columns || 80) - 3, 120);

  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={3} flexShrink={0}>
        <Text color={theme.text.accent}>{"●  "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay text={content} width={width} />
      </Box>
    </Box>
  );
}

export const NomosMessage = React.memo(NomosMessageInner);
