/**
 * Vault admin API: browse and edit the agent's long-term memory notes
 * (wiki_articles, category "memory"). Backs the settings vault page so the user
 * can see and correct what their clone knows.
 *
 * GET            -> list notes (path, title, updatedAt)
 * GET ?path=...  -> one note (full content)
 * POST {path,content,title?} -> write/revise (upsert by path)
 * DELETE ?path=  -> forget
 *
 * Note: human edits here write the markdown but do not re-embed into the vector
 * store; the agent's own writes (memory_write) do. A re-index pass is a follow-up.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";

const CATEGORY = "memory";

export async function GET(req: NextRequest) {
  try {
    const sql = getDb();
    const path = req.nextUrl.searchParams.get("path");
    if (path) {
      const [row] = await sql`
        SELECT path, title, content, updated_at
        FROM wiki_articles WHERE path = ${path} AND category = ${CATEGORY}
      `;
      if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({
        path: row.path,
        title: row.title,
        content: row.content,
        updatedAt: row.updated_at,
      });
    }
    const rows = await sql`
      SELECT path, title, updated_at, word_count
      FROM wiki_articles WHERE category = ${CATEGORY} ORDER BY path
    `;
    return NextResponse.json({
      notes: rows.map((r) => ({
        path: r.path,
        title: r.title,
        updatedAt: r.updated_at,
        wordCount: Number(r.word_count),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "db_error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const sql = getDb();
    const body = (await req.json()) as { path?: string; content?: string; title?: string };
    const path = (body.path ?? "").trim();
    if (!path) return NextResponse.json({ error: "missing_path" }, { status: 400 });
    const content = body.content ?? "";
    const title = (body.title ?? "").trim() || path.replace(/\.md$/, "").split("/").pop() || path;
    const backlinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    await sql`
      INSERT INTO wiki_articles (path, title, content, category, backlinks, word_count, compile_model)
      VALUES (${path}, ${title}, ${content}, ${CATEGORY}, ${backlinks}, ${wordCount}, 'human')
      ON CONFLICT (path) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        backlinks = EXCLUDED.backlinks,
        word_count = EXCLUDED.word_count,
        updated_at = now()
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "db_error" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const sql = getDb();
    const path = req.nextUrl.searchParams.get("path");
    if (!path) return NextResponse.json({ error: "missing_path" }, { status: 400 });
    await sql`DELETE FROM wiki_articles WHERE path = ${path} AND category = ${CATEGORY}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "db_error" },
      { status: 500 },
    );
  }
}
