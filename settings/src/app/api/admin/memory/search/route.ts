import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");

  if (!q || q.trim().length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const sql = getDb();

    const results = await sql`
      SELECT
        id,
        source,
        path,
        LEFT(text, 200) AS text_preview,
        LENGTH(text) AS text_length,
        model,
        access_count,
        created_at,
        ts_rank(to_tsvector('english', text), plainto_tsquery('english', ${q})) AS score
      FROM memory_chunks
      WHERE to_tsvector('english', text) @@ plainto_tsquery('english', ${q})
      ORDER BY score DESC
      LIMIT 20
    `;

    return NextResponse.json({
      results: results.map((r) => ({
        id: r.id,
        source: r.source,
        path: r.path,
        textPreview: r.text_preview,
        textLength: Number(r.text_length),
        model: r.model,
        accessCount: Number(r.access_count),
        createdAt: r.created_at,
        score: Number(r.score),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Search failed: ${message}` }, { status: 500 });
  }
}
