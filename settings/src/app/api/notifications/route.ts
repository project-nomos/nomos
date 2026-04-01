import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";

const CONFIG_KEY = "notifications.default";

export async function GET() {
  try {
    const sql = getDb();
    const [row] = await sql`SELECT value FROM config WHERE key = ${CONFIG_KEY}`;
    return NextResponse.json(row?.value ?? null);
  } catch {
    return NextResponse.json(null);
  }
}

export async function PUT(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as {
    platform: string;
    channelId: string;
    label?: string;
  };

  if (!body.platform || !body.channelId) {
    return NextResponse.json({ error: "platform and channelId are required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const value = JSON.stringify({
      platform: body.platform,
      channelId: body.channelId,
      label: body.label,
    });

    await sql`
      INSERT INTO config (key, value, updated_at)
      VALUES (${CONFIG_KEY}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET
        value = ${value},
        updated_at = now()
    `;

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  try {
    const sql = getDb();
    await sql`DELETE FROM config WHERE key = ${CONFIG_KEY}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
