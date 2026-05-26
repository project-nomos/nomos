import { NextResponse } from "next/server";
import { readConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { syncGoogleAccountsToDb } from "@/lib/sync-google-accounts";
import { spawn, type ChildProcess } from "node:child_process";

// Keep the child process alive at module level so it can receive the OAuth callback
let activeChild: ChildProcess | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;

function cleanup() {
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  if (activeChild) {
    activeChild.kill();
    activeChild = null;
  }
}

export async function POST() {
  let sql: ReturnType<typeof getDb> | undefined;
  try {
    sql = getDb();
  } catch {
    // DB not available
  }
  const env = await readConfig(
    ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLOUD_PROJECT"],
    sql,
  );

  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const gcpProjectId = env.GOOGLE_CLOUD_PROJECT;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "OAuth credentials not configured. Set Client ID and Client Secret first." },
      { status: 400 },
    );
  }

  // Clean up any previous auth process
  cleanup();

  // Write a valid client_secret.json (with project_id) for the CLI flow.
  // Same helper /api/env uses on save, so the two paths can't drift.
  const { writeGwsClientSecret } = await import("@/lib/sync-gws-client-secret");
  writeGwsClientSecret({
    clientId,
    clientSecret,
    projectId: gcpProjectId ?? "",
  });

  // Build args for gws auth login with explicit scopes.
  // Using --scopes ensures Gmail/Calendar are included even if the gws CLI
  // doesn't map service names to scopes correctly.
  // All Google Workspace scopes -- pass explicitly since the gws CLI's
  // -s flag doesn't reliably map service names to OAuth scopes.
  const ALL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/contacts.readonly",
  ].join(",");
  const args = ["@googleworkspace/cli", "auth", "login", "--scopes", ALL_SCOPES];

  // Spawn gws auth login with piped stdout/stderr so we can capture the OAuth URL
  try {
    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CLI_CLIENT_ID: clientId,
        GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: clientSecret,
      },
    });

    activeChild = child;

    // Kill the process after 120s if auth isn't completed
    killTimer = setTimeout(() => {
      if (activeChild === child) {
        child.kill();
        activeChild = null;
      }
      killTimer = null;
    }, 120_000);

    // Clean up references when the process exits naturally
    child.on("exit", (code) => {
      if (activeChild === child) {
        activeChild = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      // Sync accounts to DB after successful OAuth
      if (code === 0) {
        syncGoogleAccountsToDb().catch(() => {});
      }
    });

    // Read stdout to find the OAuth URL
    const url = await new Promise<string | null>((resolve) => {
      let output = "";
      const urlPattern = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/;

      // Timeout if we don't get the URL within 15 seconds
      const timeout = setTimeout(() => resolve(null), 15_000);

      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(urlPattern);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        // Some CLIs print the URL to stderr
        const match = output.match(urlPattern);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });

      child.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) resolve(null);
      });
    });

    if (!url) {
      cleanup();
      return NextResponse.json(
        {
          error:
            "Failed to get OAuth URL from gws. Check that gws CLI is installed and credentials are valid.",
        },
        { status: 500 },
      );
    }

    // Inject openid+email scopes and force consent prompt.
    // prompt=consent is required for Google Workspace accounts with
    // re-authentication policies (RAPT) -- without it, token exchange
    // fails with invalid_rapt even on fresh logins.
    let authUrl = url;
    try {
      const parsed = new URL(authUrl);
      const scope = parsed.searchParams.get("scope") ?? "";
      if (!scope.includes("openid")) {
        parsed.searchParams.set("scope", `openid email ${scope}`);
      }
      parsed.searchParams.set("prompt", "consent");
      parsed.searchParams.set("access_type", "offline");
      authUrl = parsed.toString();
    } catch {
      // If URL parsing fails, use the original
    }

    return NextResponse.json({ ok: true, url: authUrl });
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to start gws auth: ${message}` }, { status: 500 });
  }
}
