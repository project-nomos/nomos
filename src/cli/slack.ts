/**
 * CLI commands for Slack multi-workspace management.
 *
 * Usage:
 *   nomos slack listen             — Listen as you (user mode, foreground)
 *   nomos slack auth               — Connect a workspace via browser login
 *   nomos slack auth --token ...   — Connect with a manual token
 *   nomos slack workspaces         — List connected workspaces
 *   nomos slack remove <team-id>   — Remove a workspace
 */

import type { Command } from "commander";

/** Tell the running daemon to hot-reload Slack workspaces. */
async function notifyDaemonReload(): Promise<void> {
  try {
    const { GrpcClient } = await import("../ui/grpc-client.ts");
    const client = new GrpcClient({ autoReconnect: false });
    await client.connect();
    await new Promise<void>((resolve) => {
      client.sendCommand("reload-slack-workspaces", "cli:default");
      // sendCommand is fire-and-forget with event listeners, just wait briefly
      setTimeout(() => {
        client.disconnect();
        resolve();
      }, 1000);
    });
  } catch {
    // Daemon not running — will pick up workspaces on next start
  }
}

export function registerSlackCommand(program: Command): void {
  const slack = program.command("slack").description("Manage Slack workspace connections");

  slack
    .command("listen")
    .description("Listen as you — responds to DMs and @mentions using your connected workspaces")
    .action(async () => {
      await startSlackListener();
    });

  slack
    .command("auth")
    .description("Connect a Slack workspace")
    .option("-t, --token <token>", "Manual xoxp-/xoxc- token (skips browser)")
    .option("--browser", "Sign in via browser to extract session token (default)")
    .option("--oauth", "Use OAuth flow (requires SLACK_CLIENT_ID/SECRET)")
    .option("-p, --port <port>", "OAuth callback port", "9876")
    .action(async (options) => {
      if (options.token) {
        await authWithToken(options.token);
      } else if (options.oauth) {
        await authWithOAuth(parseInt(options.port, 10));
      } else {
        await authWithBrowser();
      }
    });

  slack
    .command("workspaces")
    .description("List connected Slack workspaces")
    .action(async () => {
      await listWorkspaces();
    });

  slack
    .command("remove <team-id>")
    .description("Remove a connected Slack workspace")
    .action(async (teamId: string) => {
      await removeWorkspace(teamId);
    });
}

async function startSlackListener(): Promise<void> {
  const chalk = (await import("chalk")).default;

  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken) {
    console.error(chalk.red("SLACK_APP_TOKEN is required for Socket Mode. Set it in .env"));
    console.error(
      chalk.dim("Generate one at: api.slack.com/apps → Basic Information → App-Level Tokens"),
    );
    process.exit(1);
  }

  // Load connected workspaces from the DB
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { listWorkspaces: dbList } = await import("../db/slack-workspaces.ts");
  const workspaces = await dbList();

  if (workspaces.length === 0) {
    console.error(chalk.red("No Slack workspaces connected."));
    console.error(chalk.dim('Run "nomos slack auth --token xoxp-..." to connect a workspace.'));
    const { closeDb } = await import("../db/client.ts");
    await closeDb();
    process.exit(1);
  }

  console.log(chalk.hex("#CBA6F7").bold("\nStarting Slack listener (user mode)...\n"));

  // Load agent config for SDK calls
  const { loadEnvConfig } = await import("../config/env.ts");
  const { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } =
    await import("../config/profile.ts");
  const { loadSoulFile } = await import("../config/soul.ts");
  const { loadSkills, formatSkillsForPrompt } = await import("../skills/loader.ts");
  const { createMemoryMcpServer } = await import("../sdk/tools.ts");
  const { runSession } = await import("../sdk/session.ts");

  const cfg = loadEnvConfig();
  const [identity, profile] = await Promise.all([loadAgentIdentity(), loadUserProfile()]);
  const skills = loadSkills();
  const skillsPrompt = formatSkillsForPrompt(skills);
  const soulPrompt = loadSoulFile();

  const systemPromptAppend = buildSystemPromptAppend({
    profile,
    identity,
    skillsPrompt: skillsPrompt || undefined,
    soulPrompt: soulPrompt ?? undefined,
  });

  const memoryServer = createMemoryMcpServer();
  const channelSessions = new Map<string, string>();

  const SLACK_MAX_LENGTH = 4000;

  function chunkMessage(text: string): string[] {
    if (text.length <= SLACK_MAX_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= SLACK_MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
      if (splitIdx < SLACK_MAX_LENGTH / 2) splitIdx = remaining.lastIndexOf(" ", SLACK_MAX_LENGTH);
      if (splitIdx < SLACK_MAX_LENGTH / 2) splitIdx = SLACK_MAX_LENGTH;
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    return chunks;
  }

  // Start a listener for each connected workspace
  const SlackBolt = (await import("@slack/bolt")) as typeof import("@slack/bolt") & {
    default?: typeof import("@slack/bolt");
  };
  const slackBolt = (SlackBolt.App ? SlackBolt : SlackBolt.default) ?? SlackBolt;
  const { App } = slackBolt;
  const { WebClient } = await import("@slack/web-api");

  for (const ws of workspaces) {
    const userToken = ws.access_token;
    const app = new App({ token: userToken, appToken, socketMode: true });
    const userClient = new WebClient(userToken);

    // Resolve own user ID
    const auth = await userClient.auth.test();
    const userId = auth.user_id;
    if (!userId) {
      console.error(chalk.red(`Could not resolve user ID for workspace ${ws.team_name}`));
      continue;
    }

    // User/channel name caches
    const userNameCache = new Map<string, string>();
    const channelNameCache = new Map<string, string>();

    async function lookupUserName(uid: string): Promise<string> {
      const cached = userNameCache.get(uid);
      if (cached) return cached;
      try {
        const result = await userClient.users.info({ user: uid });
        const name = result.user?.real_name ?? result.user?.name ?? uid;
        userNameCache.set(uid, name);
        return name;
      } catch {
        return uid;
      }
    }

    async function lookupChannelName(channelId: string): Promise<string> {
      const cached = channelNameCache.get(channelId);
      if (cached) return cached;
      try {
        const result = await userClient.conversations.info({ channel: channelId });
        const name = result.channel?.name ?? channelId;
        channelNameCache.set(channelId, name);
        return name;
      } catch {
        return channelId;
      }
    }

    async function handleIncoming(e: {
      text: string;
      user: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      isDM: boolean;
    }): Promise<void> {
      const senderName = await lookupUserName(e.user);
      const channelName = e.isDM ? "DM" : `#${await lookupChannelName(e.channel)}`;

      const prefix = e.isDM
        ? `[Slack DM from ${senderName}]`
        : `[Slack mention from ${senderName} in ${channelName}]`;

      const cleanText = e.text.replace(new RegExp(`<@${userId}>`, "g"), "").trim();
      if (!cleanText) return;

      const prompt = [prefix, "", cleanText].join("\n");

      const replyTs = e.thread_ts ?? e.ts;
      const sessionKey = `slack-user:${ws.team_id}:${e.channel}:${replyTs}`;
      const resumeId = channelSessions.get(sessionKey);

      console.log(
        chalk.dim(
          `\n[${ws.team_name}] ${senderName} in ${channelName}: ${cleanText.slice(0, 80)}${cleanText.length > 80 ? "..." : ""}`,
        ),
      );

      try {
        const session = runSession({
          prompt,
          model: cfg.model,
          systemPromptAppend,
          mcpServers: { "nomos-memory": memoryServer },
          allowedTools: ["mcp__nomos-memory"],
          permissionMode: cfg.permissionMode,
          resume: resumeId,
          maxTurns: 10,
        });

        let fullResponse = "";
        let sessionId: string | undefined;

        for await (const event of session) {
          if (event.type === "result") {
            sessionId = event.session_id;
            if ("result" in event) {
              fullResponse += event.result;
            }
          }
        }

        if (sessionId) {
          channelSessions.set(sessionKey, sessionId);
        }

        if (!fullResponse.trim()) {
          fullResponse = "_(no response)_";
        }

        // Send as the user
        const chunks = chunkMessage(fullResponse);
        for (const chunk of chunks) {
          await userClient.chat.postMessage({
            channel: e.channel,
            text: chunk,
            thread_ts: replyTs,
          });
        }

        console.log(chalk.green(`  → Replied (${fullResponse.length} chars)`));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`  → Error: ${errMsg}`));
      }
    }

    // Listen to all message events
    app.event("message", async ({ event }) => {
      const e = event as {
        channel_type?: string;
        text?: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
        subtype?: string;
      };

      if (e.subtype || !e.text || !e.user) return;
      if (e.user === userId) return;

      if (e.channel_type === "im") {
        await handleIncoming({
          text: e.text,
          user: e.user,
          channel: e.channel,
          ts: e.ts,
          thread_ts: e.thread_ts,
          isDM: true,
        });
      } else if (
        (e.channel_type === "channel" || e.channel_type === "group") &&
        e.text.includes(`<@${userId}>`)
      ) {
        await handleIncoming({
          text: e.text,
          user: e.user,
          channel: e.channel,
          ts: e.ts,
          thread_ts: e.thread_ts,
          isDM: false,
        });
      }
    });

    await app.start();
    console.log(
      chalk.green(
        `  Workspace: ${ws.team_name} (${ws.team_id}) — listening as ${auth.user} (${userId})`,
      ),
    );
  }

  console.log(
    chalk.hex("#CBA6F7").bold("\nListening for Slack messages as you. Press Ctrl+C to stop.\n"),
  );
  console.log(chalk.dim("Responds to DMs and @mentions. Messages are sent as your account.\n"));

  // Keep process alive
  await new Promise<void>(() => {});
}

async function authWithToken(token: string): Promise<void> {
  if (!token.startsWith("xoxp-")) {
    console.error("Token must be a user token starting with xoxp-");
    process.exit(1);
  }

  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);

  let authResult;
  try {
    authResult = await client.auth.test();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`auth.test failed: ${message}`);
    process.exit(1);
  }

  const teamId = authResult.team_id;
  const teamName = authResult.team ?? "unknown";
  const userId = authResult.user_id;

  if (!teamId || !userId) {
    console.error("Could not resolve team or user from token");
    process.exit(1);
  }

  // Run migrations to ensure table exists
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { upsertWorkspace, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");
  await upsertWorkspace({
    teamId,
    teamName,
    userId,
    accessToken: token,
  });

  // Sync tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
  await syncSlackConfigToFile();
  await notifyDaemonReload();

  console.log(`Connected workspace: ${teamName} (${teamId})`);
  console.log(`  User: ${authResult.user} (${userId})`);

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}

async function authWithOAuth(port: number): Promise<void> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required for OAuth.");
    console.error("Set them in .env or run with --token for manual entry.");
    process.exit(1);
  }

  const https = await import("node:https");
  const { execSync } = await import("node:child_process");
  const crypto = await import("node:crypto");

  // Generate ephemeral self-signed cert (required by Slack for distributed apps)
  const opensslResult = execSync(
    "openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout " +
      '-days 1 -nodes -subj "/CN=localhost" 2>/dev/null',
    { encoding: "utf-8" },
  );
  const keyMatch = opensslResult.match(
    /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/,
  );
  const certMatch = opensslResult.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  );
  if (!keyMatch || !certMatch) {
    console.error("Failed to generate self-signed certificate. Ensure OpenSSL is installed.");
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString("hex");
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

  const server = https.createServer({ key: keyMatch[0], cert: certMatch[0] }, async (req, res) => {
    const url = new URL(req.url ?? "/", `https://localhost:${port}`);
    if (url.pathname !== "/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (returnedState !== state) {
      res.writeHead(400);
      res.end("Invalid state parameter — possible CSRF. Please try again.");
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
      const { WebClient } = await import("@slack/web-api");
      const client = new WebClient();
      const result = await client.oauth.v2.access({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });

      const authedUser = result.authed_user as
        | { access_token?: string; id?: string; scope?: string }
        | undefined;
      const team = result.team as { id?: string; name?: string } | undefined;

      if (!authedUser?.access_token || !team?.id) {
        res.writeHead(500);
        res.end("OAuth succeeded but response is missing user token or team info.");
        cleanup();
        return;
      }

      // Run migrations and store
      const { runMigrations } = await import("../db/migrate.ts");
      await runMigrations();

      const { upsertWorkspace, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");
      await upsertWorkspace({
        teamId: team.id,
        teamName: team.name ?? "unknown",
        userId: authedUser.id ?? "unknown",
        accessToken: authedUser.access_token,
        scopes: authedUser.scope ?? "",
      });

      // Sync tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
      await syncSlackConfigToFile();
      await notifyDaemonReload();

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h1>Workspace connected!</h1>
          <p><strong>${team.name}</strong> (${team.id})</p>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);

      console.log(`\nConnected workspace: ${team.name} (${team.id})`);
      console.log(`  User: ${authedUser.id}`);
      console.log("  Restart the daemon to activate this workspace.");

      const { closeDb } = await import("../db/client.ts");
      await closeDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(`OAuth token exchange failed: ${message}`);
      console.error(`OAuth error: ${message}`);
    }

    cleanup();
  });

  let timeout: ReturnType<typeof setTimeout>;

  function cleanup() {
    clearTimeout(timeout);
    server.close();
  }

  server.listen(port, "127.0.0.1", () => {
    console.log(`OAuth callback server listening on https://localhost:${port}/oauth/callback`);
    console.log(`\nOpen this URL in your browser to authorize:\n`);
    console.log(`  ${authorizeUrl}\n`);

    // Try to open the browser automatically
    import("node:child_process")
      .then(({ exec }) => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${cmd} "${authorizeUrl}"`);
      })
      .catch(() => {
        // Silently fail — user can open manually
      });
  });

  // Timeout after 120 seconds
  timeout = setTimeout(() => {
    console.error("\nOAuth timed out (120s). Please try again.");
    server.close();
    process.exit(1);
  }, 120_000);

  // Keep process alive until callback or timeout
  await new Promise<void>((resolve) => {
    server.on("close", resolve);
  });
}

async function authWithBrowser(): Promise<void> {
  const chalk = (await import("chalk")).default;

  console.log(chalk.hex("#CBA6F7").bold("\nSlack Browser Login\n"));
  console.log(chalk.dim("  A browser will open. Sign in to your Slack workspace."));
  console.log(chalk.dim("  Once you're in, tokens are extracted automatically.\n"));

  const { captureSlackTokensViaBrowser } = await import("../auth/slack-browser.ts");
  type CapturedWorkspace = Awaited<ReturnType<typeof captureSlackTokensViaBrowser>>[number];

  const resolved = await captureSlackTokensViaBrowser({
    onCapture: (ws) => {
      console.log(chalk.green(`    ✓ ${ws.teamName} (${ws.teamId}) — ${ws.userId}`));
    },
    onStatus: (msg) => {
      console.log(chalk.dim(`  ${msg}`));
    },
    onTimeout: () => {
      console.error(chalk.red("\n  Timed out (2 min). No tokens captured."));
      console.error(chalk.dim("  Make sure you're signed in to Slack in the browser window."));
      process.exit(1);
    },
  });

  if (resolved.length === 0) {
    console.error(chalk.red("\n  No workspace tokens captured."));
    process.exit(1);
  }

  // ── Let user select which workspaces to connect ──

  let selected: CapturedWorkspace[];

  if (resolved.length === 1) {
    selected = resolved;
  } else {
    console.log(
      chalk.hex("#CBA6F7")(`\n  Found ${resolved.length} workspaces. Which ones to connect?\n`),
    );
    for (let i = 0; i < resolved.length; i++) {
      console.log(`    ${i + 1}. ${resolved[i].teamName} (${resolved[i].teamId})`);
    }
    console.log(`    a. All workspaces`);

    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.dim("\n  Enter choice (e.g. 1,3 or a): "), (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });

    if (answer === "a" || answer === "all") {
      selected = resolved;
    } else {
      const indices = answer.split(",").map((s) => parseInt(s.trim(), 10) - 1);
      selected = indices.filter((i) => i >= 0 && i < resolved.length).map((i) => resolved[i]);
    }

    if (selected.length === 0) {
      console.error(chalk.red("  No workspaces selected."));
      process.exit(1);
    }
  }

  // ── Store in DB ──

  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { upsertWorkspace, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");

  for (const ws of selected) {
    await upsertWorkspace({
      teamId: ws.teamId,
      teamName: ws.teamName,
      userId: ws.userId,
      accessToken: ws.token,
      scopes: "browser-session",
      cookie: ws.cookie,
    });
  }

  await syncSlackConfigToFile();
  await notifyDaemonReload();

  console.log(chalk.green(`\n  Connected ${selected.length} workspace(s):`));
  for (const ws of selected) {
    console.log(chalk.dim(`    • ${ws.teamName} (${ws.teamId})`));
  }

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}

async function listWorkspaces(): Promise<void> {
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { listWorkspaces: dbList } = await import("../db/slack-workspaces.ts");
  const workspaces = await dbList();

  if (workspaces.length === 0) {
    console.log("No Slack workspaces connected.");
    console.log('Run "nomos slack auth" to connect one.');
  } else {
    console.log(`Connected workspaces (${workspaces.length}):\n`);
    for (const ws of workspaces) {
      const date =
        ws.created_at instanceof Date ? ws.created_at.toLocaleDateString() : String(ws.created_at);
      console.log(`  ${ws.team_name} (${ws.team_id})`);
      console.log(`    User: ${ws.user_id}  Connected: ${date}`);
    }
  }

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}

async function removeWorkspace(teamId: string): Promise<void> {
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { getWorkspace, removeWorkspace: dbRemove } = await import("../db/slack-workspaces.ts");
  const ws = await getWorkspace(teamId);

  if (!ws) {
    console.error(`No workspace found with team ID: ${teamId}`);
    const { closeDb } = await import("../db/client.ts");
    await closeDb();
    process.exit(1);
  }

  // Attempt to revoke the token
  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(ws.access_token);
    await client.auth.revoke();
    console.log("Token revoked with Slack.");
  } catch {
    console.log("Token revocation skipped (may already be invalid).");
  }

  await dbRemove(teamId);

  // Sync tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
  const { syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");
  await syncSlackConfigToFile();
  await notifyDaemonReload();

  console.log(`Removed workspace: ${ws.team_name} (${ws.team_id})`);

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}
