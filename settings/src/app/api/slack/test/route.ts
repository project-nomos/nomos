import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";

export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const { teamId } = (await request.json()) as { teamId: string };

  if (!teamId) {
    return NextResponse.json({ ok: false, message: "teamId is required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const name = `slack-ws:${teamId}`;
    const [ws] = await sql`
      SELECT secrets FROM integrations WHERE name = ${name}
    `;

    if (!ws?.secrets) {
      return NextResponse.json({
        ok: false,
        message: "Workspace not found in database",
      });
    }

    let accessToken: string | undefined;
    try {
      const secrets = JSON.parse(ws.secrets as string);
      accessToken = secrets.access_token;
    } catch {
      return NextResponse.json({
        ok: false,
        message: "Could not parse workspace secrets",
      });
    }

    if (!accessToken) {
      return NextResponse.json({
        ok: false,
        message: "No access token found for workspace",
      });
    }

    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(accessToken);
    const result = await client.auth.test();

    // Update metadata if team name was missing or "unknown"
    if (result.team && result.user_id) {
      try {
        const patch = { team_name: result.team, user_id: result.user_id };
        await sql`
          UPDATE integrations
          SET metadata = metadata || ${sql.json(patch)},
          updated_at = now()
          WHERE name = ${name}
        `;
      } catch {
        // Non-blocking — metadata update is best-effort
      }
    }

    return NextResponse.json({
      ok: true,
      message: `Connected as ${result.user} in ${result.team}`,
      user: result.user,
      team: result.team,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      ok: false,
      message: `Connection test failed: ${message}`,
    });
  }
}
