/**
 * Sync Slack workspace tokens from DB to ~/.nomos/slack/config.json.
 *
 * The DB (integrations table) is the source of truth with encrypted secrets.
 * This writes a plaintext runtime snapshot that `nomos-slack-mcp` reads,
 * with 0600 file permissions.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb } from "./db";

export async function syncSlackConfigToFile(): Promise<void> {
  const sql = getDb();

  const rows = await sql`
    SELECT name, secrets, metadata, created_at
    FROM integrations
    WHERE name LIKE 'slack-ws:%' AND enabled = true
    ORDER BY metadata->>'team_name'
  `;

  const wsMap: Record<
    string,
    {
      token: string;
      teamId: string;
      teamName: string;
      userId: string;
      addedAt: string;
    }
  > = {};

  let defaultWorkspace: string | undefined;

  for (const row of rows) {
    const teamId = (row.name as string).replace(/^slack-ws:/, "");
    const meta = row.metadata as Record<string, unknown>;
    let secrets: Record<string, string>;
    try {
      secrets =
        typeof row.secrets === "string"
          ? (JSON.parse(row.secrets) as Record<string, string>)
          : (row.secrets as Record<string, string>);
    } catch {
      // Secrets are encrypted — skip this workspace in the config file
      continue;
    }

    const teamName = (meta?.team_name as string) ?? "unknown";
    const alias = teamName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || teamId;

    wsMap[alias] = {
      token: secrets.access_token ?? "",
      teamId,
      teamName,
      userId: (meta?.user_id as string) ?? "",
      addedAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };

    if (!defaultWorkspace) defaultWorkspace = alias;
  }

  const config = {
    workspaces: wsMap,
    defaultWorkspace: defaultWorkspace ?? null,
  };

  const configDir = path.join(os.homedir(), ".nomos", "slack");
  const configPath = path.join(configDir, "config.json");

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
