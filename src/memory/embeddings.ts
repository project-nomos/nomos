/**
 * Embedding generation -- supports two backends:
 *
 * 1. Gemini API (preferred): uses GOOGLE_API_KEY with the generativelanguage endpoint.
 *    No GCP project needed, works with any Gemini API key.
 *
 * 2. Vertex AI (legacy): uses GOOGLE_CLOUD_PROJECT + Application Default Credentials.
 *    Requires gcloud auth and a GCP project with aiplatform API enabled.
 *
 * Detection: GOOGLE_API_KEY -> Gemini API. GOOGLE_CLOUD_PROJECT -> Vertex AI.
 */

const EMBEDDING_DIM = 768;
const MAX_BATCH_SIZE = 100; // Gemini API batch limit

// ── Gemini API backend ──

interface GeminiEmbeddingResponse {
  embedding: { values: number[] };
}

interface GeminiBatchResponse {
  embeddings: Array<{ values: number[] }>;
}

async function generateEmbeddingsGemini(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is required for embeddings");

  const model = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    if (batch.length === 1) {
      // Single text -- use embedContent
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
      const data = (await fetchGeminiWithRetry(url, {
        model: `models/${model}`,
        content: { parts: [{ text: batch[0] }] },
        outputDimensionality: EMBEDDING_DIM,
      })) as GeminiEmbeddingResponse;
      results.push(data.embedding.values);
    } else {
      // Batch -- use batchEmbedContents
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
      const data = (await fetchGeminiWithRetry(url, {
        requests: batch.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIM,
        })),
      })) as GeminiBatchResponse;
      for (const emb of data.embeddings) {
        results.push(emb.values);
      }
    }
  }

  return results;
}

/**
 * POST to a Gemini embedding endpoint with 429 retry. Free-tier quota
 * is 100 embed requests/min/project — easy to hit during bulk ingest.
 * Google returns `retryDelay` in the error response body; we honor it,
 * cap at 60s, and retry up to 5 times before giving up.
 */
async function fetchGeminiWithRetry(url: string, body: unknown, maxAttempts = 5): Promise<unknown> {
  let attempt = 0;
  while (true) {
    attempt++;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response.json();
    }

    const bodyText = await response.text();

    if (response.status === 429 && attempt < maxAttempts) {
      const delayMs = parseGeminiRetryDelay(bodyText) ?? Math.min(2 ** attempt * 1000, 60_000);
      console.warn(
        `[embeddings] Gemini 429 (attempt ${attempt}/${maxAttempts}); sleeping ${Math.round(delayMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, delayMs + Math.random() * 500));
      continue;
    }

    throw new Error(`Gemini embedding error ${response.status}: ${bodyText}`);
  }
}

/** Parse the `retryDelay` string (e.g. "32s") from Gemini's 429 body. */
function parseGeminiRetryDelay(body: string): number | null {
  try {
    const parsed = JSON.parse(body);
    const details = parsed?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
      const delay = d?.retryDelay;
      if (typeof delay === "string") {
        const m = delay.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  } catch {
    // not JSON or unexpected shape
  }
  return null;
}

// ── Vertex AI backend (legacy) ──

interface VertexEmbeddingResponse {
  predictions: Array<{
    embeddings: {
      values: number[];
      statistics: { truncated: boolean; token_count: number };
    };
  }>;
}

async function generateEmbeddingsVertex(texts: string[]): Promise<number[][]> {
  const { GoogleAuth } = await import("google-auth-library");

  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required for Vertex AI embeddings");

  const location = process.env.VERTEX_AI_LOCATION ?? "global";
  const model = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;

  if (!accessToken) {
    throw new Error("Failed to obtain access token. Run: gcloud auth application-default login");
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
  const results: number[][] = Array.from<number[]>({ length: texts.length });

  for (let i = 0; i < texts.length; i += 250) {
    const batch = texts.slice(i, i + 250);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        instances: batch.map((text) => ({ content: text })),
        parameters: { outputDimensionality: EMBEDDING_DIM },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Vertex AI embedding error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as VertexEmbeddingResponse;
    for (let j = 0; j < data.predictions.length; j++) {
      results[i + j] = data.predictions[j].embeddings.values;
    }
  }

  return results;
}

// ── Public API ──

/**
 * Generate embeddings for one or more texts.
 * Auto-selects backend: GOOGLE_API_KEY -> Gemini API, GOOGLE_CLOUD_PROJECT -> Vertex AI.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (process.env.GOOGLE_API_KEY) {
    return generateEmbeddingsGemini(texts);
  }
  return generateEmbeddingsVertex(texts);
}

/**
 * Generate a single embedding for a text.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

/** Embedding dimensions used by the configured model. */
export const DIMENSIONS = EMBEDDING_DIM;

/**
 * Check if embedding generation is available.
 */
export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY || process.env.GOOGLE_CLOUD_PROJECT);
}
