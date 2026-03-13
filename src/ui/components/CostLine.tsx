import React from "react";
import { Box, Text } from "ink";

interface CostLineProps {
  content: string;
}

export function CostLine({ content }: CostLineProps): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{content}</Text>
    </Box>
  );
}
