import { NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";
import { syncSlackConfigToFile } from "@/lib/sync-slack-config";
import { notifyDaemonReload } from "@/lib/notify-daemon";

export async function GET() {
  try {
    const sql = getDb();
    // Read from integrations table (slack-ws:* naming)
    const rows = await sql`
      SELECT id, name, metadata, created_at, updated_at
      FROM integrations
      WHERE name LIKE 'slack-ws:%' AND enabled = true
      ORDER BY metadata->>'team_name'
    `;
    const workspaces = rows.map((r) => {
      const meta = r.metadata as Record<string, unknown>;
      return {
        id: r.id,
        team_id: (r.name as string).replace(/^slack-ws:/, ""),
        team_name: (meta?.team_name as string) ?? "unknown",
        user_id: (meta?.user_id as string) ?? "",
        scopes: (meta?.scopes as string) ?? "",
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
    return NextResponse.json({ workspaces });
  } catch {
    // Fallback: try legacy table
    try {
      const sql = getDb();
      const rows = await sql`
        SELECT id, team_id, team_name, user_id, scopes, created_at, updated_at
        FROM slack_user_tokens
        ORDER BY team_name
      `;
      return NextResponse.json({ workspaces: rows });
    } catch {
      return NextResponse.json({ workspaces: [] });
    }
  }
}

export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const { token } = (await request.json()) as { token: string };

  if (!token || !token.startsWith("xoxp-")) {
    return NextResponse.json(
      { error: "Token must be a Slack user token starting with xoxp-" },
      { status: 400 },
    );
  }

  // Validate token via auth.test
  const client = new WebClient(token);

  let authResult;
  try {
    authResult = await client.auth.test();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `auth.test failed: ${message}` }, { status: 400 });
  }

  const teamId = authResult.team_id;
  const teamName = authResult.team ?? "unknown";
  const userId = authResult.user_id;

  if (!teamId || !userId) {
    return NextResponse.json(
      { error: "Could not resolve team or user from token" },
      { status: 400 },
    );
  }

  try {
    const sql = getDb();
    const name = `slack-ws:${teamId}`;
    const secrets = JSON.stringify({ access_token: token });
    const metadataObj = { team_name: teamName, user_id: userId, scopes: "" };

    const [row] = await sql`
      INSERT INTO integrations (name, enabled, config, secrets, metadata)
      VALUES (${name}, true, '{}', ${secrets}, ${sql.json(metadataObj)})
      ON CONFLICT (name) DO UPDATE SET
        secrets = EXCLUDED.secrets,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id, name, metadata, created_at, updated_at
    `;

    const meta = row.metadata as Record<string, unknown>;
    const workspace = {
      id: row.id,
      team_id: teamId,
      team_name: (meta?.team_name as string) ?? teamName,
      user_id: (meta?.user_id as string) ?? userId,
      scopes: (meta?.scopes as string) ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    // Sync tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
    await syncSlackConfigToFile();
    notifyDaemonReload();

    return NextResponse.json({ ok: true, workspace });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Database error: ${message}` }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return NextResponse.json({ error: "teamId query parameter is required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const name = `slack-ws:${teamId}`;

    // Try to revoke the token first
    const [ws] = await sql`
      SELECT secrets FROM integrations WHERE name = ${name}
    `;

    if (ws?.secrets) {
      try {
        const raw = ws.secrets as string;
        // Only attempt revocation if secrets look like JSON (not encrypted)
        if (raw.startsWith("{")) {
          const secrets = JSON.parse(raw);
          if (secrets.access_token && !secrets.access_token.startsWith("xoxc-")) {
            // Only revoke xoxp- tokens; xoxc- browser tokens can't be revoked via API
            const revokeClient = new WebClient(secrets.access_token);
            await revokeClient.auth.revoke();
          }
        }
      } catch {
        // Token may already be invalid, encrypted, or not parseable
      }
    }

    await sql`DELETE FROM integrations WHERE name = ${name}`;

    // Sync tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
    await syncSlackConfigToFile();
    notifyDaemonReload();

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Database error: ${message}` }, { status: 500 });
  }
}
