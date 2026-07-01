import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";

// The wiki "schema" doc (Karpathy's conventions layer). Stored in managed_files so
// it is editable in hosted (no disk): the knowledge compiler reads it from the DB
// every run via readManagedFile("WIKI.md"). In power-user the file (~/.nomos/WIKI.md)
// syncs disk<->DB at boot; here we write the DB copy, which is the source of truth.
const WIKI_PATH = "WIKI.md";

export async function GET() {
  try {
    const sql = getDb();
    const rows = await sql`SELECT content FROM managed_files WHERE path = ${WIKI_PATH} LIMIT 1`;
    return NextResponse.json({ content: rows[0]?.content ?? "" });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content (string) required" }, { status: 400 });
    }
    const content = body.content;
    const hash = createHash("sha256").update(content, "utf-8").digest("hex");
    const sql = getDb();
    await sql`
      INSERT INTO managed_files (path, content, hash)
      VALUES (${WIKI_PATH}, ${content}, ${hash})
      ON CONFLICT (path) DO UPDATE SET content = ${content}, hash = ${hash}, updated_at = now()
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
