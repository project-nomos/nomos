import React from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "../markdown.ts";

interface MessageProps {
  role: "user" | "assistant" | "system";
  content: string;
}

export function Message({ role, content }: MessageProps): React.ReactElement {
  if (role === "system") {
    return (
      <Box marginLeft={0}>
        <Text dimColor>{content}</Text>
      </Box>
    );
  }

  if (role === "user") {
    return (
      <Box flexDirection="column">
        <Text color="green" bold>
          {"❯ "}
          {content}
        </Text>
      </Box>
    );
  }

  // Assistant message — render markdown
  const rendered = renderMarkdown(content);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{rendered}</Text>
    </Box>
  );
}
