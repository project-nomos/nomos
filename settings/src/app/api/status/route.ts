import { NextResponse } from "next/server";
import { readEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrationStatus } from "@/lib/types";

const execFileAsync = promisify(execFile);

export async function GET() {
  const env = readEnv();

  // Slack status
  let slackWorkspaces: { teamId: string; teamName: string; userId: string }[] =
    [];
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

  // Google status — check gws CLI for account count
  let gwsAccountCount = 0;
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
    const data = JSON.parse(stdout);
    gwsAccountCount = data.count ?? (data.accounts ?? []).length;
  } catch {
    // gws not available
  }

  const gwsServices = env.GWS_SERVICES ?? "all";

  const status: IntegrationStatus = {
    slack: {
      configured: !!(
        env.SLACK_APP_TOKEN ||
        env.SLACK_BOT_TOKEN ||
        slackWorkspaces.length > 0
      ),
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
  };

  return NextResponse.json(status);
}
