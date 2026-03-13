import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const sql = getDb();

    const [stats] = await sql`
      SELECT
        COUNT(*) AS total,
        COUNT(embedding) AS with_embedding,
        COUNT(*) - COUNT(embedding) AS without_embedding,
        COUNT(DISTINCT source) AS unique_sources,
        COALESCE(SUM(LENGTH(text)), 0) AS total_text_size
      FROM memory_chunks
    `;

    const sources = await sql`
      SELECT source, COUNT(*) AS count
      FROM memory_chunks
      GROUP BY source
      ORDER BY count DESC
    `;

    const recentChunks = await sql`
      SELECT
        id,
        source,
        path,
        LEFT(text, 200) AS text_preview,
        LENGTH(text) AS text_length,
        model,
        access_count,
        created_at
      FROM memory_chunks
      ORDER BY created_at DESC
      LIMIT 25
    `;

    return NextResponse.json({
      stats: {
        total: Number(stats.total),
        withEmbedding: Number(stats.with_embedding),
        withoutEmbedding: Number(stats.without_embedding),
        uniqueSources: Number(stats.unique_sources),
        totalTextSize: Number(stats.total_text_size),
      },
      sources: sources.map((s) => ({
        source: s.source,
        count: Number(s.count),
      })),
      recentChunks: recentChunks.map((c) => ({
        id: c.id,
        source: c.source,
        path: c.path,
        textPreview: c.text_preview,
        textLength: Number(c.text_length),
        model: c.model,
        accessCount: Number(c.access_count),
        createdAt: c.created_at,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Database connection failed: ${message}` }, { status: 500 });
  }
}
