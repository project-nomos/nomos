/**
 * Per-workspace Slack MCP server factory.
 *
 * Creates one in-process MCP server per workspace, each using that
 * workspace's token. Named "slack-ws-<team_id>" to distinguish from
 * the default "nomos-slack" server.
 *
 * The agent sees separate tool namespaces per workspace:
 *   mcp__slack-ws-T01ABC__slack_read_channel
 *   mcp__slack-ws-T02DEF__slack_read_channel
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { createSlackTools } from "./slack-mcp.ts";

/**
 * Create a single per-workspace Slack MCP server.
 */
function createWorkspaceMcpServer(token: string, teamId: string): McpSdkServerConfigWithInstance {
  const getClient = async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");
    return new WebClient(token);
  };

  return createSdkMcpServer({
    name: `slack-ws-${teamId}`,
    version: "0.1.0",
    tools: createSlackTools(getClient),
  });
}

/**
 * Create per-workspace Slack MCP server instances for all workspaces in the DB.
 *
 * Each workspace gets its own MCP server with tools bound to that workspace's token.
 * Returns a map of server name → config to merge into the runtime's MCP servers.
 */
export async function createPerWorkspaceSlackMcpServers(): Promise<
  Record<string, McpSdkServerConfigWithInstance>
> {
  const { listWorkspaces } = await import("../db/slack-workspaces.ts");
  const workspaces = await listWorkspaces();
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};

  for (const ws of workspaces) {
    const serverName = `slack-ws-${ws.team_id}`;
    servers[serverName] = createWorkspaceMcpServer(ws.access_token, ws.team_id);
  }

  return servers;
}
