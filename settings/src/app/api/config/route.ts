import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { validateOrigin } from "@/lib/validate-request";

/** Allowed config key prefixes for reading/writing. */
const ALLOWED_PREFIXES = ["agent.", "user.", "app.", "consent.", "notifications.", "personas."];

function isAllowedKey(key: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function GET() {
  try {
    const sql = getDb();
    const rows = await sql<Array<{ key: string; value: unknown }>>`
      SELECT key, value FROM config
      ORDER BY key
    `;

    // Return both flat map and array format for compatibility
    const result: Record<string, unknown> = {};
    const configArray: Array<{ key: string; value: unknown }> = [];
    for (const row of rows) {
      result[row.key] = row.value;
      configArray.push({ key: row.key, value: row.value });
    }

    return NextResponse.json({ ...result, config: configArray });
  } catch {
    return NextResponse.json({}, { status: 200 });
  }
}

// POST alias for PUT (some pages use POST)
export async function POST(request: Request) {
  return PUT(request);
}

export async function PUT(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as Record<string, unknown>;

  const sql = getDb();
  const updates: string[] = [];

  // Support two formats:
  // 1. { key: "app.foo", value: "bar" } -- single key-value pair (used by proactive page)
  // 2. { "app.foo": "bar", "app.baz": "qux" } -- flat map of key-value pairs (used by settings page)
  let entries: Array<[string, unknown]>;

  if (typeof body.key === "string" && "value" in body) {
    // Format 1: single { key, value }
    entries = [[body.key, body.value]];
  } else {
    // Format 2: flat map
    entries = Object.entries(body);
  }

  for (const [key, value] of entries) {
    if (!isAllowedKey(key)) continue;

    if (value === null || value === undefined || value === "") {
      await sql`DELETE FROM config WHERE key = ${key}`;
      updates.push(key);
    } else {
      // Config table uses JSONB -- store the value directly via sql.json()
      // Don't double-stringify (JSON.stringify("true") => '"true"' which breaks reads)
      const jsonValue = sql.json(value as string);
      await sql`
        INSERT INTO config (key, value, updated_at)
        VALUES (${key}, ${jsonValue}, now())
        ON CONFLICT (key) DO UPDATE SET
          value = ${jsonValue},
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
