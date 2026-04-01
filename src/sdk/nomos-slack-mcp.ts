/**
 * External Slack MCP server configuration.
 *
 * Uses @project-nomos/slack-mcp (`nomos-slack-mcp`) for Slack access.
 * The server starts over stdio and provides tools for reading/sending
 * messages, searching, listing channels/users, reactions, and status.
 *
 * Auth is managed by `nomos-slack-add-workspace` — tokens are stored
 * in ~/.nomos/slack/config.json (not env vars).
 *
 * @see https://github.com/project-nomos/nomos-slack-mcp
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Check if nomos-slack-mcp is configured (sync).
 *
 * Returns true if ~/.nomos/slack/config.json exists with workspaces,
 * or if legacy SLACK_BOT_TOKEN / SLACK_USER_TOKEN env vars are set.
 */
export function isSlackMcpConfigured(): boolean {
  // Check nomos-slack-mcp config file
  try {
    const configPath = join(homedir(), ".nomos", "slack", "config.json");
    if (existsSync(configPath)) {
      const data = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
      if (data.workspaces && Object.keys(data.workspaces).length > 0) {
        return true;
      }
    }
  } catch {
    // Config not readable — fall through
  }

  // Legacy env var fallback
  return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN);
}

/**
 * Check if nomos-slack-mcp is configured (async, DB-backed).
 * Checks DB for slack-ws:* workspace entries first, then falls back to sync check.
 */
export async function isSlackMcpConfiguredAsync(): Promise<boolean> {
  try {
    const { listWorkspaces } = await import("../db/slack-workspaces.ts");
    const workspaces = await listWorkspaces();
    if (workspaces.length > 0) return true;
  } catch {
    // DB not available — fall through
  }
  return isSlackMcpConfigured();
}

/**
 * Create the MCP server config for Slack via `nomos-slack-mcp`.
 *
 * Returns a single MCP config — nomos-slack-mcp handles multi-workspace
 * internally via ~/.nomos/slack/config.json.
 */
export function createSlackMcpConfigs(): Record<string, McpServerConfig> {
  return {
    "nomos-slack": {
      type: "stdio",
      command: "npx",
      args: ["nomos-slack-mcp"],
    } as McpServerConfig,
  };
}

/**
 * Create Slack MCP configs (async, same as sync for now).
 * Async variant for consistency with Google Workspace pattern.
 */
export async function createSlackMcpConfigsAsync(): Promise<Record<string, McpServerConfig>> {
  return createSlackMcpConfigs();
}
