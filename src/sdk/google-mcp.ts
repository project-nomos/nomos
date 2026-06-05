/**
 * Google Workspace MCP orchestrator for HOSTED mode.
 *
 * Selects the backend via NOMOS_GOOGLE_BACKEND:
 *   - "official" (default): Google's OFFICIAL remote MCP servers
 *     (gmailmcp/calendarmcp/drivemcp) for read/draft/calendar/drive, plus our
 *     in-process Gmail SEND tool (opt-in) — the official Gmail MCP is draft-only.
 *   - "rest": our full direct-REST in-process server (google-rest-mcp.ts), kept
 *     as a flag-selectable backup if the official servers misbehave.
 *
 * Either way the token comes from our own lifecycle (getValidAccessToken,
 * refreshed per call). Power-user mode keeps the gws CLI (agent-runtime init).
 */

import type { McpHttpServerConfig, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../lib/logger.ts";
import {
  getValidAccessToken,
  isGoogleIntegrationConfigured,
  listGoogleAccounts,
} from "../auth/google-integration.ts";
import { buildGoogleRestMcpServer, createGoogleSendMcpServer } from "./google-rest-mcp.ts";

const log = createLogger("google-mcp");

/** Official Google Workspace remote MCP endpoints. */
const GOOGLE_MCP_ENDPOINTS = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
} as const;

/** MCP-safe slug for an email (server names feed `mcp__<name>__tool`). */
function emailSlug(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Official mode: register Google's remote MCP servers for each connected account
 * with that account's bearer token (default account → clean names, extras →
 * email-slug suffix), plus our in-process Gmail send tool when sending is enabled.
 */
async function buildGoogleOfficialMcpServers(
  userId: string,
): Promise<Record<string, McpServerConfig>> {
  const accounts = await listGoogleAccounts(userId);
  if (accounts.length === 0) return {};

  const servers: Record<string, McpServerConfig> = {};
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
      const http: McpHttpServerConfig = {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
      };
      servers[`${prefix}-${service}`] = http;
    }
  }
  // Gmail send is ours and opt-in: one in-process server, account param.
  if (accounts.some((a) => a.sendEnabled)) {
    servers["nomos-google-send"] = createGoogleSendMcpServer(userId);
  }
  if (Object.keys(servers).length > 0) {
    log.info({ userId, servers: Object.keys(servers) }, "registered Google MCP servers (official)");
  }
  return servers;
}

/**
 * Build the Google MCP servers for a user (hosted). Empty when Google isn't
 * configured or the user has connected nothing. Backend chosen by
 * NOMOS_GOOGLE_BACKEND ("official" default, "rest" backup).
 */
export async function buildGoogleMcpServers(
  userId: string,
): Promise<Record<string, McpServerConfig>> {
  if (!isGoogleIntegrationConfigured()) return {};
  const backend = (process.env.NOMOS_GOOGLE_BACKEND ?? "official").toLowerCase();
  try {
    if (backend === "rest") return await buildGoogleRestMcpServer(userId);
    return await buildGoogleOfficialMcpServers(userId);
  } catch (err) {
    log.warn(
      { userId, backend, err: err instanceof Error ? err.message : err },
      "failed to build Google MCP servers",
    );
    return {};
  }
}
