/**
 * Slack workspace token CRUD operations.
 *
 * Delegates to the unified `integrations` table using "slack-ws:{teamId}" naming.
 * Maintains the same exported interface for backward compatibility.
 */

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
}): Promise<SlackWorkspaceRow> {
  const integration = await upsertIntegration(integrationName(params.teamId), {
    secrets: { access_token: params.accessToken },
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
