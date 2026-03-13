import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";

/** Allowed config key prefixes for reading/writing. */
const ALLOWED_PREFIXES = ["agent.", "user."];

function isAllowedKey(key: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function GET() {
  try {
    const sql = getDb();
    const rows = await sql<Array<{ key: string; value: unknown }>>`
      SELECT key, value FROM config
      WHERE key LIKE 'agent.%' OR key LIKE 'user.%'
      ORDER BY key
    `;

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({}, { status: 200 });
  }
}

export async function PUT(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as Record<string, unknown>;

  const sql = getDb();
  const updates: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!isAllowedKey(key)) continue;

    if (value === null || value === undefined || value === "") {
      await sql`DELETE FROM config WHERE key = ${key}`;
      updates.push(key);
    } else {
      await sql`
        INSERT INTO config (key, value, updated_at)
        VALUES (${key}, ${JSON.stringify(value)}, now())
        ON CONFLICT (key) DO UPDATE SET
          value = ${JSON.stringify(value)},
          updated_at = now()
      `;
      updates.push(key);
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No valid keys to update" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, updated: updates });
}
