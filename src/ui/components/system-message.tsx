import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

interface SystemMessageProps {
  content: string;
}

function SystemMessageInner({ content }: SystemMessageProps): React.ReactElement {
  return (
    <Box paddingLeft={3}>
      <Text dimColor>
        {theme.symbol.system + " "}
        {content}
      </Text>
    </Box>
  );
}

export const SystemMessage = React.memo(SystemMessageInner);
