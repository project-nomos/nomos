import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_MODEL = "veo-3.0-generate-preview";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_TIME_MS = 300_000; // 5 minutes

interface GenerateVideoResponse {
  name: string; // operation name for polling
}

interface OperationResponse {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: {
    generatedVideos: Array<{
      video: {
        uri?: string;
        bytesBase64Encoded?: string;
        mimeType: string;
      };
    }>;
  };
}

/**
 * Generate a video using Google's Veo model via the Generative Language API.
 * This is a long-running operation: submits the request, then polls until complete.
 * Returns the path to the saved video file.
 */
export async function generateVideo(
  prompt: string,
  options?: {
    apiKey?: string;
    model?: string;
    outputPath?: string;
    durationSeconds?: number;
  },
): Promise<{ videoPath: string }> {
  const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required for video generation. Get one at https://aistudio.google.com/apikey",
    );
  }

  const model = options?.model ?? process.env.NOMOS_VIDEO_GENERATION_MODEL ?? DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${apiKey}`;

  // Start the generation
  const startResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        ...(options?.durationSeconds ? { durationSeconds: options.durationSeconds } : {}),
      },
    }),
  });

  if (!startResponse.ok) {
    const body = await startResponse.text();
    throw new Error(`Veo API error ${startResponse.status}: ${body}`);
  }

  const operation = (await startResponse.json()) as GenerateVideoResponse;

  if (!operation.name) {
    throw new Error("No operation name returned from Veo API");
  }

  // Poll until completion
  const pollEndpoint = `https://generativelanguage.googleapis.com/v1beta/${operation.name}?key=${apiKey}`;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    await sleep(POLL_INTERVAL_MS);

    const pollResponse = await fetch(pollEndpoint);
    if (!pollResponse.ok) {
      const body = await pollResponse.text();
      throw new Error(`Veo polling error ${pollResponse.status}: ${body}`);
    }

    const result = (await pollResponse.json()) as OperationResponse;

    if (result.error) {
      throw new Error(`Video generation failed: ${result.error.message}`);
    }

    if (result.done && result.response) {
      const videos = result.response.generatedVideos;
      if (!videos?.length) {
        throw new Error("No video was generated");
      }

      const video = videos[0].video;
      const ext = video.mimeType === "video/webm" ? ".webm" : ".mp4";
      const fileName = `generated-${randomBytes(4).toString("hex")}${ext}`;
      const outputPath = options?.outputPath ?? join(tmpdir(), fileName);

      if (video.bytesBase64Encoded) {
        const buffer = Buffer.from(video.bytesBase64Encoded, "base64");
        await writeFile(outputPath, buffer);
      } else if (video.uri) {
        // Download from GCS URI
        const downloadRes = await fetch(video.uri);
        if (!downloadRes.ok) {
          throw new Error(`Failed to download video from ${video.uri}`);
        }
        const buffer = Buffer.from(await downloadRes.arrayBuffer());
        await writeFile(outputPath, buffer);
      } else {
        throw new Error("Video response contains neither inline data nor URI");
      }

      return { videoPath: outputPath };
    }
  }

  throw new Error(`Video generation timed out after ${MAX_POLL_TIME_MS / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
