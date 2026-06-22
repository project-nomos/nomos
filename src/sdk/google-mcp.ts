/**
 * Google Workspace MCP orchestrator.
 *
 * Backend via NOMOS_GOOGLE_BACKEND; the DEFAULT is mode-aware — "cli" for the
 * open-source power-user build, "official" for hosted:
 *   - "cli" (power-user default): nothing registered here; the agent reaches
 *     Google through the gws CLI on PATH (wired in agent-runtime init).
 *   - "official" (hosted default): Google's OFFICIAL remote MCP servers
 *     (gmailmcp/calendarmcp/drivemcp) for read/draft/calendar/drive, plus our
 *     in-process Gmail SEND tool (opt-in) — the official Gmail MCP is draft-only.
 *   - "rest": our full direct-REST in-process server (google-rest-mcp.ts), kept
 *     as a flag-selectable backup if the official servers misbehave.
 *
 * For official/rest the token comes from our own lifecycle (getValidAccessToken,
 * refreshed per call).
 */

import type { McpHttpServerConfig, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../lib/logger.ts";
import { isHosted } from "../config/mode.ts";
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
 * Build the Google MCP servers for a user. Empty for the "cli" backend, when
 * Google isn't configured, or when the user has connected nothing. Backend via
 * NOMOS_GOOGLE_BACKEND; default is mode-aware ("cli" power-user, "official"
 * hosted), "rest" is the backup.
 */
export async function buildGoogleMcpServers(
  userId: string,
): Promise<Record<string, McpServerConfig>> {
  // Default is mode-aware: the open-source power-user build uses the gws CLI,
  // hosted uses Google's official remote MCP. Override with NOMOS_GOOGLE_BACKEND.
  // Empty/whitespace falls through to the default rather than "unknown".
  const raw = process.env.NOMOS_GOOGLE_BACKEND?.trim().toLowerCase();
  const backend = raw || (isHosted() ? "official" : "cli");

  // "cli": the agent reaches Google through the gws CLI (via Bash), so there is
  // no in-process/remote MCP to register here.
  if (backend === "cli") return {};

  // official / rest both rely on our OAuth-managed tokens.
  if (!isGoogleIntegrationConfigured()) return {};
  try {
    if (backend === "rest") return await buildGoogleRestMcpServer(userId);
    if (backend === "official") return await buildGoogleOfficialMcpServers(userId);
    log.warn({ backend }, "unknown NOMOS_GOOGLE_BACKEND — using official");
    return await buildGoogleOfficialMcpServers(userId);
  } catch (err) {
    log.warn(
      { userId, backend, err: err instanceof Error ? err.message : err },
      "failed to build Google MCP servers",
    );
    return {};
  }
}

/**
 * A system-prompt section asserting the user's ACTIVE Google access (hosted), so
 * the agent stops telling the user that Gmail/Calendar/Drive needs configuring
 * when the MCP tools are in fact registered. Empty for the "cli" backend, when
 * Google isn't configured, or when no accounts are connected.
 */
export async function buildGoogleIntegrationPrompt(
  userId: string,
  hasGoogleServers: boolean,
): Promise<string> {
  const raw = process.env.NOMOS_GOOGLE_BACKEND?.trim().toLowerCase();
  const backend = raw || (isHosted() ? "official" : "cli");
  if (backend === "cli") return ""; // power-user advertises Google via the gws CLI summary

  // No usable Google MCP registered for this user (not configured, no connected
  // account, or a dead token). Tell the agent the TRUTH so it stops hunting for
  // tools, confabulating that they're "loading in the background", browser-driving
  // Google, or inventing workarounds (the live focus-block flailing).
  if (!hasGoogleServers) {
    return [
      "## Google Workspace: not connected",
      "Gmail, Calendar, and Drive are **not connected** for this user — you currently have NO Google tools.",
      "Do NOT 'check for', 'wait for', or say Google tools are still loading. Do NOT use the Browser tool to open or sign into Google. Do NOT invent a workaround (a reminder, a manual checklist, a calendar.google.com walkthrough) unless the user explicitly asks for one.",
      "If the user asks for something that needs Google, tell them plainly it isn't connected and that they can connect it in Settings → Google, then stop and wait — don't keep trying.",
    ].join("\n");
  }

  let accounts: Awaited<ReturnType<typeof listGoogleAccounts>>;
  try {
    accounts = await listGoogleAccounts(userId);
  } catch {
    return "";
  }
  if (accounts.length === 0) return "";

  const lines = accounts.map((a) => {
    const send = a.sendEnabled ? "sending enabled" : "draft-only (sending is off)";
    return `- ${a.email}${a.isDefault ? " (default)" : ""}: Gmail, Calendar, and Drive; ${send}`;
  });
  return [
    "## Connected Google accounts",
    "You have **active, authenticated** Google Workspace access right now through the Google MCP: Gmail, Calendar, and Drive. Do NOT tell the user that Gmail, Calendar, or Drive needs to be connected or configured; you already have access for the accounts below.",
    ...lines,
    "Use the matching `mcp__google-gmail__*`, `mcp__google-calendar__*`, and `mcp__google-drive__*` tools (the default account uses the unsuffixed `google-*` servers; additional accounts are suffixed with an email slug). The `google-gmail`, `gmail-inbox-triage`, `google-calendar*`, and `google-drive` skills give workflow guidance. Gmail sending is opt-in per account; for draft-only accounts, create a draft and ask the user before sending.",
  ].join("\n");
}
