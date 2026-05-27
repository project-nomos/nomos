import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/encryption";

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
  topic?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const name = `slack-ws:${teamId}`;
    const [ws] = await sql`
      SELECT secrets FROM integrations WHERE name = ${name}
    `;

    if (!ws?.secrets) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    // The integrations table encrypts the `secrets` column at rest
    // (AES-256-GCM via ENCRYPTION_KEY). We must decrypt before parsing.
    // Same pattern as settings/src/lib/sync-slack-config.ts.
    let accessToken: string | undefined;
    try {
      const raw = typeof ws.secrets === "string" ? ws.secrets : JSON.stringify(ws.secrets ?? {});
      const decrypted = decryptSecret(raw);
      const secrets = JSON.parse(decrypted) as Record<string, string>;
      accessToken = secrets.access_token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Could not decrypt workspace secrets: ${message}` },
        { status: 500 },
      );
    }

    if (!accessToken) {
      return NextResponse.json({ error: "No access token found" }, { status: 500 });
    }

    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(accessToken);

    const channels: SlackChannel[] = [];

    // Fetch public and private channels (paginated)
    let cursor: string | undefined;
    do {
      const result = await client.conversations.list({
        types: "public_channel,private_channel,im",
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      for (const ch of result.channels ?? []) {
        if (!ch.id || !ch.name) continue;
        channels.push({
          id: ch.id,
          name: ch.is_im ? `DM: ${ch.name}` : ch.name,
          is_private: !!ch.is_private,
          is_im: !!ch.is_im,
          topic: ch.topic?.value || undefined,
        });
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Sort: DMs first, then channels alphabetically
    channels.sort((a, b) => {
      if (a.is_im !== b.is_im) return a.is_im ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ channels });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to list channels: ${message}` }, { status: 500 });
  }
}
