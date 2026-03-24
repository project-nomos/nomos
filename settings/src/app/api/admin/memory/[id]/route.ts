import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const sql = getDb();

    const rows = await sql`
      SELECT
        id,
        source,
        path,
        text,
        LENGTH(text) AS text_length,
        model,
        access_count,
        created_at
      FROM memory_chunks
      WHERE id = ${id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return NextResponse.json({ error: "Chunk not found" }, { status: 404 });
    }

    const c = rows[0];
    return NextResponse.json({
      id: c.id,
      source: c.source,
      path: c.path,
      text: c.text,
      textLength: Number(c.text_length),
      model: c.model,
      accessCount: Number(c.access_count),
      createdAt: c.created_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Failed to fetch chunk: ${message}` }, { status: 500 });
  }
}
