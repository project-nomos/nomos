/**
 * Google Workspace MCP server configuration.
 *
 * Uses @googleworkspace/cli (`gws`) for Google Workspace access.
 * The `gws mcp` command starts an MCP server over stdio that
 * auto-generates tools from Google's Discovery API.
 *
 * Auth is managed by `gws auth login` — no env vars needed for
 * the child process. Client credentials live in ~/.config/gws/.
 *
 * @see https://github.com/googleworkspace/cli
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

/**
 * Check if Google Workspace is configured (sync).
 *
 * Returns true if `gws` has authenticated accounts OR
 * if GOOGLE_OAUTH_CLIENT_ID is set (backwards compat for settings UI setup).
 */
export function isGoogleWorkspaceConfigured(): boolean {
  // Quick env-based check first (sync)
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return true;
  }

  // Check if gws has accounts (async check done at startup via initialize)
  // For sync compatibility, also check if client_secret.json exists
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const clientSecretPath = path.join(os.homedir(), ".config", "gws", "client_secret.json");
    return fs.existsSync(clientSecretPath);
  } catch {
    return false;
  }
}

/**
 * Check if Google Workspace is configured (async, DB-backed).
 * Checks DB integration "google" first, then falls back to sync check.
 */
export async function isGoogleWorkspaceConfiguredAsync(): Promise<boolean> {
  try {
    const { getIntegration } = await import("../db/integrations.ts");
    const integration = await getIntegration("google");
    if (integration?.enabled) return true;
  } catch {
    // DB not available — fall through
  }
  return isGoogleWorkspaceConfigured();
}

/**
 * Create the MCP server config for Google Workspace via `gws mcp`.
 *
 * Returns a single MCP config — gws handles multi-account internally.
 * Services are controlled by the GWS_SERVICES env var (default: "all").
 */
const DEFAULT_GWS_SERVICES = "gmail,drive,calendar,sheets,docs,slides";

export function createGoogleWorkspaceMcpConfigs(): Record<string, McpServerConfig> {
  const services = process.env.GWS_SERVICES ?? DEFAULT_GWS_SERVICES;

  return {
    "google-workspace": {
      type: "stdio",
      command: "npx",
      args: ["gws", "mcp", "-s", services, "--tool-mode", "compact"],
    } as McpServerConfig,
  };
}

/**
 * Create GWS MCP configs with DB-backed service config.
 * Reads GWS_SERVICES from DB integration config, falls back to env.
 */
export async function createGoogleWorkspaceMcpConfigsAsync(): Promise<
  Record<string, McpServerConfig>
> {
  let services = process.env.GWS_SERVICES ?? DEFAULT_GWS_SERVICES;
  try {
    const { getIntegration } = await import("../db/integrations.ts");
    const integration = await getIntegration("google");
    if (integration?.config.services && typeof integration.config.services === "string") {
      services = integration.config.services;
    }
  } catch {
    // DB not available — use env
  }

  return {
    "google-workspace": {
      type: "stdio",
      command: "npx",
      args: ["gws", "mcp", "-s", services, "--tool-mode", "compact"],
    } as McpServerConfig,
  };
}

/**
 * Check if the `gws` binary is available.
 */
export async function isGwsAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "--version"], { timeout: 10000 });
    const version = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

/**
 * List authenticated gws accounts.
 */
export async function listGwsAccounts(): Promise<{
  accounts: Array<{ email: string; default: boolean }>;
  count: number;
}> {
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
    const data = JSON.parse(stdout);
    const defaultAccount = data.default ?? "";
    const accounts = (data.accounts ?? []).map((email: string) => ({
      email,
      default: email === defaultAccount,
    }));
    return { accounts, count: data.count ?? accounts.length };
  } catch {
    return { accounts: [], count: 0 };
  }
}
