/**
 * Tree-structured agent progress display.
 * Shows agent tasks with tree indicators (├─, └─), tool counts, and token usage.
 * Inspired by Claude Code's AgentProgressLine.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export interface AgentTask {
  /** Agent type (e.g., "coordinator", "worker") */
  agentType: string;
  /** Task description */
  description?: string;
  /** Agent name or identifier */
  name?: string;
  /** Number of tools used */
  toolUseCount?: number;
  /** Tokens consumed */
  tokens?: number;
  /** Whether this agent is done */
  isResolved?: boolean;
  /** Whether this agent is running in the background */
  isAsync?: boolean;
  /** Last tool used (shown while active) */
  lastTool?: string;
  /** Custom color for the agent type label */
  color?: string;
}

interface AgentProgressLineProps {
  task: AgentTask;
  /** Whether this is the last item in the tree */
  isLast?: boolean;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function AgentProgressLineInner({
  task,
  isLast = false,
}: AgentProgressLineProps): React.ReactElement {
  const treeChar = isLast ? "└─ " : "├─ ";
  const agentColor = task.color ?? "#89DCEB";

  // Status text
  let statusText: string;
  if (task.isResolved) {
    statusText = "Done";
  } else if (task.isAsync) {
    statusText = task.description ?? "Running in background";
  } else if (task.lastTool) {
    statusText = task.lastTool;
  } else {
    statusText = task.description ?? "Working...";
  }

  // Stats suffix
  const stats: string[] = [];
  if (task.toolUseCount && task.toolUseCount > 0 && !task.isAsync) {
    stats.push(`${task.toolUseCount} tool ${task.toolUseCount === 1 ? "use" : "uses"}`);
  }
  if (task.tokens && task.tokens > 0 && !task.isAsync) {
    stats.push(`${formatNumber(task.tokens)} tokens`);
  }
  const statsSuffix = stats.length > 0 ? ` · ${stats.join(" · ")}` : "";

  return (
    <Box>
      <Text dimColor>{treeChar}</Text>
      <Text color={agentColor} bold>
        {task.agentType}
      </Text>
      {task.name && <Text dimColor> {task.name}</Text>}
      <Text color={theme.text.secondary}>
        {" "}
        {task.isResolved ? <Text color={theme.status.success}>{statusText}</Text> : statusText}
      </Text>
      {statsSuffix && <Text dimColor>{statsSuffix}</Text>}
    </Box>
  );
}

export const AgentProgressLine = React.memo(AgentProgressLineInner);

/**
 * Renders a full agent tree with coordinator and workers.
 */
interface AgentTreeProps {
  coordinator: AgentTask;
  workers: AgentTask[];
}

function AgentTreeInner({ coordinator, workers }: AgentTreeProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={1}>
      <AgentProgressLine task={coordinator} isLast={workers.length === 0} />
      {workers.map((worker, idx) => (
        <AgentProgressLine
          key={worker.name ?? idx}
          task={worker}
          isLast={idx === workers.length - 1}
        />
      ))}
    </Box>
  );
}

export const AgentTree = React.memo(AgentTreeInner);
