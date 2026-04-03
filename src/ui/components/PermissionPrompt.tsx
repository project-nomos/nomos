/**
 * Permission prompt with inline diff preview for file edits.
 * Shows proposed changes before the user approves or rejects.
 * Inspired by Claude Code's FileEditPermissionRequest.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.ts";
import { StructuredDiff, parseUnifiedDiff } from "./StructuredDiff.tsx";

export interface PermissionRequest {
  /** Type of operation */
  type: "file_edit" | "file_write" | "bash" | "tool";
  /** Tool or operation name */
  name: string;
  /** File path (for file operations) */
  filePath?: string;
  /** Unified diff string (for file edits) */
  diff?: string;
  /** Command to execute (for bash) */
  command?: string;
  /** Description of what the tool will do */
  description?: string;
}

interface PermissionPromptProps {
  request: PermissionRequest;
  onApprove: () => void;
  onReject: () => void;
  /** Optional: approve for this session (always allow) */
  onAlwaysAllow?: () => void;
}

function PermissionPromptInner({
  request,
  onApprove,
  onReject,
  onAlwaysAllow,
}: PermissionPromptProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  useInput((_input, key) => {
    if (_input === "y" || _input === "Y") {
      onApprove();
    } else if (_input === "n" || _input === "N") {
      onReject();
    } else if ((_input === "a" || _input === "A") && onAlwaysAllow) {
      onAlwaysAllow();
    } else if (key.tab) {
      setExpanded((prev) => !prev);
    }
  });

  const icon = request.type === "file_edit" ? "✎" : request.type === "bash" ? "$" : "⚡";

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header */}
      <Box>
        <Text color={theme.status.warning} bold>
          {icon}{" "}
        </Text>
        <Text bold>{request.name}</Text>
        {request.filePath && <Text dimColor> {request.filePath}</Text>}
      </Box>

      {/* Description */}
      {request.description && (
        <Box marginLeft={2}>
          <Text dimColor>{request.description}</Text>
        </Box>
      )}

      {/* Command preview */}
      {request.command && (
        <Box marginLeft={2} marginTop={1}>
          <Text color={theme.status.warning}>$ </Text>
          <Text>{request.command}</Text>
        </Box>
      )}

      {/* Diff preview */}
      {request.diff && expanded && (
        <Box marginLeft={2} marginTop={1}>
          {(() => {
            const { filePath, hunks } = parseUnifiedDiff(request.diff);
            return <StructuredDiff filePath={filePath || request.filePath || ""} hunks={hunks} />;
          })()}
        </Box>
      )}

      {/* Action prompt */}
      <Box marginTop={1} gap={1}>
        <Text dimColor>
          {"  "}
          <Text color={theme.status.success} bold>
            y
          </Text>
          es{" · "}
          <Text color={theme.status.error} bold>
            n
          </Text>
          o
          {onAlwaysAllow && (
            <>
              {" · "}
              <Text color={theme.text.link} bold>
                a
              </Text>
              lways allow
            </>
          )}
          {request.diff && (
            <>
              {" · "}
              <Text dimColor>tab</Text> {expanded ? "collapse" : "expand"} diff
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

export const PermissionPrompt = React.memo(PermissionPromptInner);
