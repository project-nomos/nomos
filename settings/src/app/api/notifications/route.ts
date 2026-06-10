import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";

const CONFIG_KEY = "notifications.default";

/**
 * Config key for a notification target. With ?userId=<id> it's the per-owner
 * override (`notifications.default:<id>`); without, the global default. The
 * daemon resolves per-owner first, then falls back to the global default.
 */
function keyFor(userId: string | null): string {
  return userId ? `${CONFIG_KEY}:${userId}` : CONFIG_KEY;
}

export async function GET(request: Request) {
  try {
    const userId = new URL(request.url).searchParams.get("userId");
    const sql = getDb();
    const [row] = await sql`SELECT value FROM config WHERE key = ${keyFor(userId)}`;
    if (!row?.value) return NextResponse.json(null);
    // Handle double-encoded JSON (old bug: JSON.stringify before insert into JSONB)
    const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return NextResponse.json(val);
  } catch {
    return NextResponse.json(null);
  }
}

export async function PUT(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const userId = new URL(request.url).searchParams.get("userId");
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
    const value = {
      platform: body.platform,
      channelId: body.channelId,
      label: body.label,
    };

    await sql`
      INSERT INTO config (key, value, updated_at)
      VALUES (${keyFor(userId)}, ${sql.json(value)}, now())
      ON CONFLICT (key) DO UPDATE SET
        value = ${sql.json(value)},
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
    const userId = new URL(request.url).searchParams.get("userId");
    const sql = getDb();
    await sql`DELETE FROM config WHERE key = ${keyFor(userId)}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
