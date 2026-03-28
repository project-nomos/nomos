/**
 * Slack workspace token CRUD operations.
 *
 * Delegates to the unified `integrations` table using "slack-ws:{teamId}" naming.
 * Maintains the same exported interface for backward compatibility.
 *
 * The DB is the source of truth — tokens are encrypted at rest via AES-256-GCM.
 * After mutations, `syncSlackConfigToFile()` writes a plaintext snapshot to
 * ~/.nomos/slack/config.json for the external `nomos-slack-mcp` process.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  upsertIntegration,
  getIntegration,
  listIntegrationsByPrefix,
  removeIntegration,
  type Integration,
} from "./integrations.ts";

export interface SlackWorkspaceRow {
  id: string;
  team_id: string;
  team_name: string;
  user_id: string;
  access_token: string;
  cookie_d?: string;
  scopes: string;
  created_at: Date;
  updated_at: Date;
}

function integrationName(teamId: string): string {
  return `slack-ws:${teamId}`;
}

function toWorkspaceRow(integration: Integration, teamId: string): SlackWorkspaceRow {
  return {
    id: integration.id,
    team_id: teamId,
    team_name: (integration.metadata.team_name as string) ?? "unknown",
    user_id: (integration.metadata.user_id as string) ?? "",
    access_token: integration.secrets.access_token ?? "",
    cookie_d: integration.secrets.cookie_d,
    scopes: (integration.metadata.scopes as string) ?? "",
    created_at: integration.created_at,
    updated_at: integration.updated_at,
  };
}

function extractTeamId(name: string): string {
  return name.replace(/^slack-ws:/, "");
}

export async function upsertWorkspace(params: {
  teamId: string;
  teamName: string;
  userId: string;
  accessToken: string;
  scopes?: string;
  cookie?: string;
}): Promise<SlackWorkspaceRow> {
  const secrets: Record<string, string> = { access_token: params.accessToken };
  if (params.cookie) {
    secrets.cookie_d = params.cookie;
  }
  const integration = await upsertIntegration(integrationName(params.teamId), {
    secrets,
    metadata: {
      team_name: params.teamName,
      user_id: params.userId,
      scopes: params.scopes ?? "",
    },
  });
  return toWorkspaceRow(integration, params.teamId);
}

export async function listWorkspaces(): Promise<SlackWorkspaceRow[]> {
  const integrations = await listIntegrationsByPrefix("slack-ws:");
  return integrations.map((i) => toWorkspaceRow(i, extractTeamId(i.name)));
}

export async function getWorkspace(teamId: string): Promise<SlackWorkspaceRow | null> {
  const integration = await getIntegration(integrationName(teamId));
  if (!integration) return null;
  return toWorkspaceRow(integration, teamId);
}

export async function getWorkspaceByPlatform(platform: string): Promise<SlackWorkspaceRow | null> {
  const teamId = platform.replace(/^slack-user:/, "");
  if (!teamId || teamId === platform) return null;
  return getWorkspace(teamId);
}

export async function removeWorkspace(teamId: string): Promise<SlackWorkspaceRow | null> {
  const integration = await removeIntegration(integrationName(teamId));
  if (!integration) return null;
  return toWorkspaceRow(integration, teamId);
}

/**
 * Sync all DB workspace tokens to ~/.nomos/slack/config.json.
 *
 * This is the file `nomos-slack-mcp` reads at startup. The DB remains the
 * source of truth (encrypted at rest); this file is a plaintext runtime
 * snapshot written with 0600 permissions.
 */
export async function syncSlackConfigToFile(): Promise<void> {
  const workspaces = await listWorkspaces();

  const configDir = path.join(homedir(), ".nomos", "slack");
  const configPath = path.join(configDir, "config.json");

  // Build the config structure nomos-slack-mcp expects
  const wsMap: Record<
    string,
    {
      token: string;
      teamId: string;
      teamName: string;
      userId: string;
      addedAt: string;
      cookie?: string;
    }
  > = {};

  let defaultWorkspace: string | undefined;

  for (const ws of workspaces) {
    const alias = ws.team_name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || ws.team_id;
    wsMap[alias] = {
      token: ws.access_token,
      teamId: ws.team_id,
      teamName: ws.team_name,
      userId: ws.user_id,
      addedAt: ws.created_at instanceof Date ? ws.created_at.toISOString() : String(ws.created_at),
      cookie: ws.cookie_d,
    };
    if (!defaultWorkspace) defaultWorkspace = alias;
  }

  const config = {
    workspaces: wsMap,
    defaultWorkspace: defaultWorkspace ?? null,
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
