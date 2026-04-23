import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const PLATFORMS = ["slack", "discord", "telegram", "imessage", "email", "whatsapp"];
const VALID_MODES = ["always_ask", "auto_approve", "notify_only"];

export async function GET() {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT key, value FROM config WHERE key LIKE ${"consent.mode.%"}
    `;

    const modes: Record<string, string> = {};
    for (const platform of PLATFORMS) {
      modes[platform] = "always_ask"; // default
    }
    for (const row of rows) {
      const platform = (row.key as string).replace("consent.mode.", "");
      const value = row.value as string;
      if (PLATFORMS.includes(platform) && VALID_MODES.includes(value)) {
        modes[platform] = value;
      }
    }

    return NextResponse.json(modes);
  } catch {
    // Return defaults if DB not available
    const defaults: Record<string, string> = {};
    for (const p of PLATFORMS) defaults[p] = "always_ask";
    return NextResponse.json(defaults);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { platform: string; mode: string };

    if (!PLATFORMS.includes(body.platform)) {
      return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }
    if (!VALID_MODES.includes(body.mode)) {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const sql = getDb();
    const key = `consent.mode.${body.platform}`;
    const jsonValue = sql.json(body.mode);

    await sql`
      INSERT INTO config (key, value, updated_at)
      VALUES (${key}, ${jsonValue}, now())
      ON CONFLICT (key) DO UPDATE SET
        value = ${jsonValue},
        updated_at = now()
    `;

    return NextResponse.json({ ok: true, platform: body.platform, mode: body.mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
