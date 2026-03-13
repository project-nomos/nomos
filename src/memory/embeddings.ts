import { GoogleAuth } from "google-auth-library";

const EMBEDDING_DIM = 768;
const MAX_BATCH_SIZE = 250; // Vertex AI supports up to 250 instances per request

interface VertexEmbeddingResponse {
  predictions: Array<{
    embeddings: {
      values: number[];
      statistics: { truncated: boolean; token_count: number };
    };
  }>;
}

let authClient: GoogleAuth | undefined;

function getAuth(): GoogleAuth {
  if (!authClient) {
    authClient = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return authClient;
}

function getConfig(): { projectId: string; location: string; model: string } {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("GOOGLE_CLOUD_PROJECT is required for embeddings. Set it in your environment.");
  }

  return {
    projectId,
    location: process.env.VERTEX_AI_LOCATION ?? "global",
    model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
  };
}

/**
 * Generate embeddings for one or more texts using Google's gemini-embedding-001
 * via the Vertex AI API. Requires GOOGLE_CLOUD_PROJECT and ADC credentials.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { projectId, location, model } = getConfig();
  const auth = getAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;

  if (!accessToken) {
    throw new Error("Failed to obtain access token. Run: gcloud auth application-default login");
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;

  const results: number[][] = new Array(texts.length);

  // Process in batches
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

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
 * Returns false if GOOGLE_CLOUD_PROJECT is not configured.
 */
export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}
