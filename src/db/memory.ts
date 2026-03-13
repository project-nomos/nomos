import { getDb } from "./client.ts";

export interface MemoryChunk {
  id: string;
  source: string;
  path?: string;
  text: string;
  embedding?: number[];
  startLine?: number;
  endLine?: number;
  hash?: string;
  model?: string;
}

export interface MemorySearchResult {
  id: string;
  text: string;
  path: string | null;
  source: string;
  score: number;
  created_at?: Date;
  access_count?: number;
}

export async function storeMemoryChunk(chunk: MemoryChunk): Promise<void> {
  const sql = getDb();
  const embeddingStr = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null;

  await sql`
    INSERT INTO memory_chunks (id, source, path, text, embedding, start_line, end_line, hash, model)
    VALUES (
      ${chunk.id},
      ${chunk.source},
      ${chunk.path ?? null},
      ${chunk.text},
      ${embeddingStr ? sql`${embeddingStr}::vector` : null},
      ${chunk.startLine ?? null},
      ${chunk.endLine ?? null},
      ${chunk.hash ?? null},
      ${chunk.model ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      text = EXCLUDED.text,
      embedding = EXCLUDED.embedding,
      hash = EXCLUDED.hash,
      model = EXCLUDED.model,
      updated_at = now()
  `;
}

export async function searchMemoryByVector(
  embedding: number[],
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  const sql = getDb();
  const embeddingStr = `[${embedding.join(",")}]`;

  return sql<MemorySearchResult[]>`
    SELECT
      id, text, path, source,
      1 - (embedding <=> ${embeddingStr}::vector) as score,
      created_at, access_count
    FROM memory_chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;
}

export async function searchMemoryByText(
  query: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  const sql = getDb();

  return sql<MemorySearchResult[]>`
    SELECT
      id, text, path, source,
      ts_rank(to_tsvector('english', text), plainto_tsquery('english', ${query})) as score,
      created_at, access_count
    FROM memory_chunks
    WHERE to_tsvector('english', text) @@ plainto_tsquery('english', ${query})
    ORDER BY score DESC
    LIMIT ${limit}
  `;
}

/**
 * Record access to memory chunks (increment access_count, update last_accessed_at).
 * Called after search results are returned to the user.
 */
export async function recordMemoryAccess(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = getDb();
  await sql`
    UPDATE memory_chunks
    SET access_count = access_count + 1,
        last_accessed_at = now()
    WHERE id = ANY(${ids})
  `;
}

export async function deleteMemoryBySource(source: string): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM memory_chunks WHERE source = ${source}
  `;
  return result.count;
}

export async function deleteMemoryByPath(path: string): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM memory_chunks WHERE path = ${path}
  `;
  return result.count;
}
