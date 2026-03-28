import { NextResponse } from "next/server";
import crypto from "node:crypto";
import http from "node:http";
import { readEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { syncSlackConfigToFile } from "@/lib/sync-slack-config";
import { notifyDaemonReload } from "@/lib/notify-daemon";

// Track active OAuth server so we can clean up
let activeServer: http.Server | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
// Track the expected state to validate callback
let pendingState: string | null = null;
// Resolve function for signaling completion
let onComplete: ((workspace: { teamId: string; teamName: string }) => void) | null = null;

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
  const env = readEnv();

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
  const port = 9876;
  const redirectUri = `http://localhost:${port}/slack/oauth/callback`;

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

  // Create a temporary HTTP server to receive the OAuth callback
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/slack/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (returnedState !== pendingState) {
      res.writeHead(400);
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
      const metadata = JSON.stringify({
        team_name: teamName,
        user_id: userId,
        scopes,
      });

      await sql`
        INSERT INTO integrations (name, enabled, config, secrets, metadata)
        VALUES (${name}, true, '{}', ${secrets}, ${metadata}::jsonb)
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
      server.listen(port, () => resolve());
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
