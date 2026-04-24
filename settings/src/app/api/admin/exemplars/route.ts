import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();
    const context = request.nextUrl.searchParams.get("context");

    // Stats by context
    const contextStats = await sql`
      SELECT
        metadata->>'context' AS context,
        COUNT(*) AS count,
        ROUND(AVG((metadata->>'score')::numeric), 2) AS avg_score
      FROM memory_chunks
      WHERE metadata->>'category' = 'exemplar'
      GROUP BY metadata->>'context'
      ORDER BY count DESC
    `;

    // Total count
    const [total] = await sql`
      SELECT COUNT(*) AS count FROM memory_chunks
      WHERE metadata->>'category' = 'exemplar'
    `;

    // Exemplars (optionally filtered by context)
    const exemplars = context
      ? await sql`
        SELECT
          id,
          LEFT(text, 500) AS text_preview,
          LENGTH(text) AS text_length,
          metadata->>'context' AS context,
          (metadata->>'score')::numeric AS score,
          metadata->>'platform' AS platform,
          metadata->>'reasoning' AS reasoning,
          created_at
        FROM memory_chunks
        WHERE metadata->>'category' = 'exemplar'
          AND metadata->>'context' = ${context}
        ORDER BY (metadata->>'score')::numeric DESC
        LIMIT 50
      `
      : await sql`
        SELECT
          id,
          LEFT(text, 500) AS text_preview,
          LENGTH(text) AS text_length,
          metadata->>'context' AS context,
          (metadata->>'score')::numeric AS score,
          metadata->>'platform' AS platform,
          metadata->>'reasoning' AS reasoning,
          created_at
        FROM memory_chunks
        WHERE metadata->>'category' = 'exemplar'
        ORDER BY (metadata->>'score')::numeric DESC
        LIMIT 100
      `;

    return NextResponse.json({
      total: Number(total.count),
      contexts: contextStats.map((c) => ({
        context: c.context,
        count: Number(c.count),
        avgScore: Number(c.avg_score),
      })),
      exemplars: exemplars.map((e) => ({
        id: e.id,
        textPreview: e.text_preview,
        textLength: Number(e.text_length),
        context: e.context,
        score: Number(e.score),
        platform: e.platform,
        reasoning: e.reasoning,
        createdAt: e.created_at,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Delete an exemplar by ID. */
export async function DELETE(request: NextRequest) {
  try {
    const sql = getDb();
    const { id } = await request.json();
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    await sql`DELETE FROM memory_chunks WHERE id = ${id} AND metadata->>'category' = 'exemplar'`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
