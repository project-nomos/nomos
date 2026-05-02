/**
 * Google Workspace MCP server configuration.
 *
 * Uses @googleworkspace/cli (`gws`) for Google Workspace access.
 * The `gws mcp` command starts an MCP server over stdio that
 * auto-generates tools from Google's Discovery API.
 *
 * Auth is managed by `gws auth login` -- no env vars needed for
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
 * Returns true if `gws` has valid auth OR
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
    const configPath = path.join(os.homedir(), ".config", "gws", "client_secret.json");
    return fs.existsSync(configPath);
  } catch {
    return false;
  }
}

/**
 * Check if Google Workspace is configured (async, DB-backed).
 * Checks DB for google-ws:* account entries first, then falls back to sync check.
 */
export async function isGoogleWorkspaceConfiguredAsync(): Promise<boolean> {
  try {
    const { listGoogleAccounts } = await import("../db/google-accounts.ts");
    const accounts = await listGoogleAccounts();
    if (accounts.length > 0) return true;
  } catch {
    // DB not available -- fall through
  }
  return isGoogleWorkspaceConfigured();
}

/**
 * Create the MCP server config for Google Workspace via `gws mcp`.
 *
 * Returns a single MCP config.
 * Services are controlled by the GWS_SERVICES env var (default: "all").
 */
const DEFAULT_GWS_SERVICES = "gmail,drive,calendar,sheets,docs,slides";

export function createGoogleWorkspaceMcpConfigs(): Record<string, McpServerConfig> {
  const services = process.env.GWS_SERVICES ?? DEFAULT_GWS_SERVICES;

  return {
    "google-workspace": {
      type: "stdio",
      command: "npx",
      args: ["@googleworkspace/cli", "mcp", "-s", services, "--tool-mode", "compact"],
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
    // DB not available -- use env
  }

  return {
    "google-workspace": {
      type: "stdio",
      command: "npx",
      args: ["@googleworkspace/cli", "mcp", "-s", services, "--tool-mode", "compact"],
    } as McpServerConfig,
  };
}

/**
 * Check if the `gws` binary is available.
 */
export async function isGwsAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "--version"], {
      timeout: 10000,
    });
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
 * Get gws auth status (v0.22.5+).
 */
export async function getGwsAuthStatus(): Promise<{
  authenticated: boolean;
  authMethod: string;
  storage: string;
  tokenCacheExists: boolean;
  email?: string;
}> {
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
      timeout: 10000,
    });
    const status = JSON.parse(stdout);
    const authenticated =
      status.auth_method !== "none" ||
      status.token_cache_exists === true ||
      status.storage !== "none";

    let email: string | undefined;

    // Try to resolve email from credentials if authenticated
    if (authenticated) {
      try {
        const { stdout: exportOut } = await execFileAsync(
          "npx",
          ["@googleworkspace/cli", "auth", "export", "--unmasked"],
          { timeout: 10000 },
        );
        const creds = JSON.parse(exportOut) as Record<string, string>;
        if (creds.refresh_token && creds.client_id && creds.client_secret) {
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: creds.client_id,
              client_secret: creds.client_secret,
              refresh_token: creds.refresh_token,
              grant_type: "refresh_token",
            }),
          });
          if (tokenRes.ok) {
            const tokenData = (await tokenRes.json()) as Record<string, string>;
            // Try userinfo
            try {
              const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
              });
              if (userRes.ok) {
                const info = (await userRes.json()) as Record<string, string>;
                if (info.email) email = info.email;
              }
            } catch {
              // openid scope not available
            }
            // Fallback: Gmail profile
            if (!email) {
              try {
                const gmailRes = await fetch(
                  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                  { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
                );
                if (gmailRes.ok) {
                  const profile = (await gmailRes.json()) as Record<string, string>;
                  if (profile.emailAddress) email = profile.emailAddress;
                }
              } catch {
                // Gmail not available
              }
            }
          }
        }
      } catch {
        // Could not export or resolve email
      }
    }

    return {
      authenticated,
      authMethod: status.auth_method ?? "none",
      storage: status.storage ?? "none",
      tokenCacheExists: status.token_cache_exists ?? false,
      email,
    };
  } catch {
    return {
      authenticated: false,
      authMethod: "none",
      storage: "none",
      tokenCacheExists: false,
    };
  }
}

/**
 * List authenticated gws accounts.
 * In gws v0.22.5+, there is at most one account (from auth status).
 * Falls back to DB for account metadata.
 */
export async function listGwsAccounts(): Promise<{
  accounts: Array<{ email: string; default: boolean }>;
  count: number;
}> {
  const status = await getGwsAuthStatus();

  if (status.authenticated && status.email) {
    return {
      accounts: [{ email: status.email, default: true }],
      count: 1,
    };
  }

  // Fall back to DB for account listing
  try {
    const { listGoogleAccounts } = await import("../db/google-accounts.ts");
    const dbAccounts = await listGoogleAccounts();
    return {
      accounts: dbAccounts.map((a) => ({ email: a.email, default: a.is_default })),
      count: dbAccounts.length,
    };
  } catch {
    if (status.authenticated) {
      return { accounts: [{ email: "(authenticated)", default: true }], count: 1 };
    }
    return { accounts: [], count: 0 };
  }
}
