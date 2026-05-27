import { NextResponse } from "next/server";
import { readConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { syncGoogleAccountsToDb } from "@/lib/sync-google-accounts";
import {
  pendingAuthDir,
  newPendingToken,
  writeClientSecretToDir,
  promotePendingDir,
  cleanupPendingDir,
} from "@/lib/gws-accounts";
import { spawn, type ChildProcess } from "node:child_process";

// Keep the child process alive at module level so it can receive the OAuth
// callback (which fires asynchronously after the user finishes the browser
// flow). We also stash the pending token on the child so the exit handler
// can promote the working dir to its final per-account home.
interface ActiveAuth {
  child: ChildProcess;
  pendingToken: string;
}
let active: ActiveAuth | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;

function cleanup() {
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  if (active) {
    active.child.kill();
    cleanupPendingDir(active.pendingToken);
    active = null;
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

  // Each auth run gets its own pending working dir under
  // `~/.config/gws/.pending-<token>/`. We don't know the email yet — it
  // comes back with the OAuth token — so we keep the dir anonymous until
  // success, then rename to `~/.config/gws/<email>/` and register in the
  // manifest. This works for both first-time auth and re-auth.
  const pendingToken = newPendingToken();
  const pendingDir = pendingAuthDir(pendingToken);
  writeClientSecretToDir(pendingDir, {
    clientId,
    clientSecret,
    projectId: gcpProjectId ?? "",
  });

  // Build args for `gws auth login`. We pass all scopes we'll ever need
  // — the OAuth consent screen in GCP must already include them; otherwise
  // Google silently drops the un-registered ones at request time.
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

  try {
    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // CRITICAL: scope this gws invocation to the pending dir so it
        // doesn't blow away any other account already authorized.
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: pendingDir,
        GOOGLE_WORKSPACE_CLI_CLIENT_ID: clientId,
        GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: clientSecret,
      },
    });

    active = { child, pendingToken };

    // Kill the process after 120s if auth isn't completed
    killTimer = setTimeout(() => {
      if (active?.child === child) {
        child.kill();
        cleanupPendingDir(pendingToken);
        active = null;
      }
      killTimer = null;
    }, 120_000);

    // On exit code 0: resolve the email from the granted token, then move
    // the pending dir to ~/.config/gws/<email>/ and register it in the
    // manifest. The Settings UI polls /api/google/status to detect this.
    child.on("exit", async (code) => {
      if (active?.child === child) active = null;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (code !== 0) {
        cleanupPendingDir(pendingToken);
        return;
      }

      try {
        const email = await resolveEmailFromPendingDir(pendingDir);
        if (!email) {
          cleanupPendingDir(pendingToken);
          return;
        }
        promotePendingDir(pendingToken, email);
        await syncGoogleAccountsToDb().catch(() => {});
      } catch (err) {
        console.error("[oauth/start] Failed to finalize auth:", err);
        cleanupPendingDir(pendingToken);
      }
    });

    // Read stdout/stderr to find the OAuth URL gws prints.
    const url = await new Promise<string | null>((resolve) => {
      let output = "";
      const urlPattern = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/;

      const timeout = setTimeout(() => resolve(null), 15_000);

      const handleChunk = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(urlPattern);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);
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

    // Inject openid+email scopes and force consent prompt. prompt=consent
    // is required for Google Workspace accounts with re-authentication
    // policies (RAPT) — without it, token exchange fails with invalid_rapt
    // even on fresh logins.
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

    return NextResponse.json({ ok: true, url: authUrl, pendingToken });
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to start gws auth: ${message}` }, { status: 500 });
  }
}

/**
 * Pull the just-granted refresh token out of the pending dir, exchange it
 * for an access token, then hit Google's userinfo endpoint to resolve the
 * email. Returns null if any step fails (the dir is left intact for the
 * caller to clean up).
 */
async function resolveEmailFromPendingDir(dir: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  let creds: { client_id: string; client_secret: string; refresh_token: string };
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["@googleworkspace/cli", "auth", "export", "--unmasked"],
      {
        timeout: 10_000,
        env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: dir },
      },
    );
    const jsonStart = stdout.search(/\{/);
    if (jsonStart < 0) return null;
    creds = JSON.parse(stdout.slice(jsonStart));
  } catch (err) {
    console.error("[oauth/start] auth export failed:", err);
    return null;
  }

  if (!creds.refresh_token || !creds.client_id || !creds.client_secret) return null;

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
  if (!tokenRes.ok) return null;

  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) return null;

  // Try userinfo first (works if openid scope was granted).
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) {
      const info = (await userRes.json()) as { email?: string };
      if (info.email) return info.email;
    }
  } catch {
    // openid not granted — fall through to Gmail profile.
  }

  // Fallback: Gmail profile (works if Gmail scope was granted).
  try {
    const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { emailAddress?: string };
      if (profile.emailAddress) return profile.emailAddress;
    }
  } catch {
    // Gmail scope not granted either — give up.
  }

  return null;
}
