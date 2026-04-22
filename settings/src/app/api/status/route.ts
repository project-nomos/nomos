import { NextResponse } from "next/server";
import { readConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrationStatus } from "@/lib/types";

const execFileAsync = promisify(execFile);

export async function GET() {
  let sql: ReturnType<typeof getDb> | undefined;
  try {
    sql = getDb();
  } catch {
    // DB not available -- will be created per-section below
  }
  const env = await readConfig(
    [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GWS_SERVICES",
      "DISCORD_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "WHATSAPP_ENABLED",
      "IMESSAGE_ENABLED",
      "IMESSAGE_MODE",
      "IMESSAGE_AGENT_MODE",
    ],
    sql,
  );

  // Slack status
  let slackWorkspaces: { teamId: string; teamName: string; userId: string }[] = [];
  try {
    const sql = getDb();
    // Read from integrations table (slack-ws:* naming)
    const rows = await sql`
      SELECT name, metadata FROM integrations
      WHERE name LIKE 'slack-ws:%' AND enabled = true
      ORDER BY metadata->>'team_name'
    `;
    slackWorkspaces = rows.map((r) => ({
      teamId: (r.name as string).replace(/^slack-ws:/, ""),
      teamName: ((r.metadata as Record<string, unknown>)?.team_name as string) ?? "unknown",
      userId: ((r.metadata as Record<string, unknown>)?.user_id as string) ?? "",
    }));
  } catch {
    // Fallback: try legacy table
    try {
      const sql = getDb();
      const rows = await sql`
        SELECT team_id, team_name, user_id FROM slack_user_tokens ORDER BY team_name
      `;
      slackWorkspaces = rows.map((r) => ({
        teamId: r.team_id as string,
        teamName: r.team_name as string,
        userId: r.user_id as string,
      }));
    } catch {
      // Table may not exist yet
    }
  }

  // Google status -- check gws auth status + DB accounts
  let gwsAccountCount = 0;
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "status"], { timeout: 10000 });
    const status = JSON.parse(stdout);
    if (status.auth_method !== "none" || status.token_cache_exists || status.storage !== "none") {
      gwsAccountCount = 1;
    }
  } catch {
    // gws not available -- fall back to DB
  }
  if (gwsAccountCount === 0 && sql) {
    try {
      const [row] = await sql`
        SELECT COUNT(*)::int AS count FROM integrations
        WHERE name LIKE 'google-ws:%' AND enabled = true
      `;
      gwsAccountCount = (row?.count as number) ?? 0;
    } catch {
      // integrations table may not exist
    }
  }

  const gwsServices = env.GWS_SERVICES ?? "all";

  const status: IntegrationStatus = {
    slack: {
      configured: !!(env.SLACK_APP_TOKEN || env.SLACK_BOT_TOKEN || slackWorkspaces.length > 0),
      appToken: !!env.SLACK_APP_TOKEN,
      botToken: !!env.SLACK_BOT_TOKEN,
      workspaces: slackWorkspaces,
    },
    google: {
      configured: !!(
        (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) ||
        gwsAccountCount > 0
      ),
      clientId: !!env.GOOGLE_OAUTH_CLIENT_ID,
      services: gwsServices,
      accountCount: gwsAccountCount,
    },
    discord: {
      configured: !!env.DISCORD_BOT_TOKEN,
      botToken: !!env.DISCORD_BOT_TOKEN,
    },
    telegram: {
      configured: !!env.TELEGRAM_BOT_TOKEN,
      botToken: !!env.TELEGRAM_BOT_TOKEN,
    },
    whatsapp: {
      configured: env.WHATSAPP_ENABLED === "true" || env.WHATSAPP_ENABLED === "1",
    },
    imessage: {
      configured: env.IMESSAGE_ENABLED === "true" || env.IMESSAGE_ENABLED === "1",
      mode: env.IMESSAGE_MODE ?? "chatdb",
      agentMode: env.IMESSAGE_AGENT_MODE ?? "passive",
    },
  };

  return NextResponse.json(status);
}
