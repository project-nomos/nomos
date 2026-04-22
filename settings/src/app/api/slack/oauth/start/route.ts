import { NextResponse } from "next/server";
import crypto from "node:crypto";
import https from "node:https";
import { execSync } from "node:child_process";
import { readConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { syncSlackConfigToFile } from "@/lib/sync-slack-config";
import { notifyDaemonReload } from "@/lib/notify-daemon";

// Track active OAuth server so we can clean up
let activeServer: https.Server | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
// Track the expected state to validate callback
let pendingState: string | null = null;
// Resolve function for signaling completion
let onComplete: ((workspace: { teamId: string; teamName: string }) => void) | null = null;

function generateSelfSignedCert(): { key: string; cert: string } {
  const result = execSync(
    "openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout " +
      '-days 1 -nodes -subj "/CN=localhost" 2>/dev/null',
    { encoding: "utf-8" },
  );
  const keyMatch = result.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
  const certMatch = result.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!keyMatch || !certMatch) {
    throw new Error("Failed to generate self-signed certificate");
  }
  return { key: keyMatch[0], cert: certMatch[0] };
}

function cleanup() {
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
  pendingState = null;
  onComplete = null;
}

export async function POST() {
  let sql: ReturnType<typeof getDb> | undefined;
  try {
    sql = getDb();
  } catch {
    // DB not available
  }
  const env = await readConfig(["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"], sql);

  const clientId = env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be configured first." },
      { status: 400 },
    );
  }

  // Clean up any previous OAuth flow
  cleanup();

  const state = crypto.randomBytes(16).toString("hex");
  pendingState = state;
  const port = 8934;
  const redirectUri = `https://localhost:${port}/oauth/callback`;

  const userScopes = [
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "mpim:history",
    "mpim:read",
    "chat:write",
    "users:read",
    "users:read.email",
    "search:read",
    "reactions:write",
    "reactions:read",
    "users.profile:write",
  ].join(",");

  const authorizeUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${userScopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  // Generate self-signed cert for HTTPS (required by Slack for distributed apps)
  let key: string;
  let cert: string;
  try {
    ({ key, cert } = generateSelfSignedCert());
  } catch {
    return NextResponse.json(
      { error: "Failed to generate SSL certificate. Ensure OpenSSL is installed." },
      { status: 500 },
    );
  }

  // Create a temporary HTTPS server to receive the OAuth callback
  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url ?? "/", `https://localhost:${port}`);
    if (url.pathname !== "/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1e1e2e;color:#cdd6f4">
          <h1 style="color:#f38ba8">Authorization Error</h1>
          <p>Slack returned: ${error}</p>
        </body></html>
      `);
      cleanup();
      return;
    }

    if (returnedState !== pendingState) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("Invalid state parameter. Please try again.");
      cleanup();
      return;
    }

    if (!code) {
      res.writeHead(400);
      res.end("No authorization code received.");
      cleanup();
      return;
    }

    try {
      // Exchange code for token
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      const tokenData = (await tokenRes.json()) as {
        ok?: boolean;
        error?: string;
        authed_user?: { access_token?: string; id?: string; scope?: string };
        team?: { id?: string; name?: string };
      };

      if (!tokenData.ok || !tokenData.authed_user?.access_token || !tokenData.team?.id) {
        res.writeHead(500);
        res.end(`OAuth failed: ${tokenData.error ?? "Missing token or team info"}`);
        cleanup();
        return;
      }

      const teamId = tokenData.team.id;
      const teamName = tokenData.team.name ?? "unknown";
      const userId = tokenData.authed_user.id ?? "unknown";
      const accessToken = tokenData.authed_user.access_token;
      const scopes = tokenData.authed_user.scope ?? "";

      // Store in DB
      const sql = getDb();
      const name = `slack-ws:${teamId}`;
      const secrets = JSON.stringify({ access_token: accessToken });
      const metadataObj = {
        team_name: teamName,
        user_id: userId,
        scopes,
      };

      await sql`
        INSERT INTO integrations (name, enabled, config, secrets, metadata)
        VALUES (${name}, true, '{}', ${secrets}, ${sql.json(metadataObj)})
        ON CONFLICT (name) DO UPDATE SET
          secrets = EXCLUDED.secrets,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `;

      // Sync to config file for nomos-slack-mcp
      await syncSlackConfigToFile();
      notifyDaemonReload();

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1e1e2e;color:#cdd6f4">
          <h1 style="color:#cba6f7">Workspace Connected!</h1>
          <p><strong>${teamName}</strong> (${teamId})</p>
          <p style="color:#a6adc8">You can close this tab and return to Settings.</p>
        </body></html>
      `);

      // Signal completion for polling
      if (onComplete) {
        onComplete({ teamId, teamName });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(`OAuth token exchange failed: ${message}`);
    }

    cleanup();
  });

  // Start listening
  try {
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch {
    return NextResponse.json(
      { error: `Port ${port} is in use. Close any other OAuth flows and try again.` },
      { status: 500 },
    );
  }

  activeServer = server;

  // Auto-cleanup after 120s
  killTimer = setTimeout(() => {
    cleanup();
  }, 120_000);

  // Clean up on exit
  server.on("close", () => {
    if (activeServer === server) {
      activeServer = null;
    }
  });

  return NextResponse.json({ ok: true, url: authorizeUrl });
}
