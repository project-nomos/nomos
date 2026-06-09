import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * List the memory owners on this instance (mirrors src/auth/org-members.ts
 * listMemoryOwners): the distinct user_ids that have any memory. Power-user
 * collapses to a single 'local' owner; hosted returns each member. Used by the
 * per-owner notification settings page.
 */
export async function GET() {
  try {
    const sql = getDb();
    const rows = await sql<{ user_id: string }[]>`
      SELECT DISTINCT user_id FROM memory_chunks
      UNION
      SELECT DISTINCT user_id FROM user_model
      ORDER BY user_id
    `;
    const owners = rows.map((r) => r.user_id).filter(Boolean);
    return NextResponse.json({ owners: owners.length > 0 ? owners : ["local"] });
  } catch {
    return NextResponse.json({ owners: ["local"] });
  }
}
