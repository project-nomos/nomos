/**
 * Builds Google Workspace remote-MCP server configs for the agent in HOSTED
 * mode. For each Google account the user has connected, we register the Gmail,
 * Calendar, and Drive remote MCP servers (Developer Preview) with that account's
 * current access token in the Authorization header — so every MCP call for a
 * given account is authenticated as that account.
 *
 * Default account → clean names (`google-gmail`, `google-calendar`,
 * `google-drive`). Additional accounts get an email-slug suffix so a user can
 * connect work + personal and the agent can target either.
 *
 * Power-user mode uses the gws CLI instead (google-workspace-mcp.ts); this is
 * only wired when isHosted().
 */

import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../lib/logger.ts";
import {
  GOOGLE_MCP_ENDPOINTS,
  getValidAccessToken,
  isGoogleIntegrationConfigured,
  listGoogleAccounts,
} from "../auth/google-integration.ts";

const log = createLogger("google-remote-mcp");

/** A short, MCP-safe slug for an email (server names feed `mcp__<name>__tool`). */
function emailSlug(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the remote Google MCP servers for a user's connected accounts. Returns
 * an empty map when Google isn't configured or the user has connected nothing.
 * Tokens are refreshed as needed (getValidAccessToken).
 */
export async function buildGoogleMcpServers(
  userId: string,
): Promise<Record<string, McpHttpServerConfig>> {
  if (!isGoogleIntegrationConfigured()) return {};

  let accounts;
  try {
    accounts = await listGoogleAccounts(userId);
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : err },
      "failed to list Google accounts",
    );
    return {};
  }
  if (accounts.length === 0) return {};

  const servers: Record<string, McpHttpServerConfig> = {};
  for (const acct of accounts) {
    const token = await getValidAccessToken(userId, acct.email);
    if (!token) {
      log.warn(
        { email: acct.email },
        "skipping Google MCP for account — no valid token (needs re-connect)",
      );
      continue;
    }
    const prefix = acct.isDefault ? "google" : `google-${emailSlug(acct.email)}`;
    for (const [service, url] of Object.entries(GOOGLE_MCP_ENDPOINTS)) {
      servers[`${prefix}-${service}`] = {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
      };
    }
  }
  if (Object.keys(servers).length > 0) {
    log.info({ userId, servers: Object.keys(servers) }, "registered Google remote MCP servers");
  }
  return servers;
}
