import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_MODEL = "gemini-3-pro-image-preview";

interface GeminiGenerateResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
}

/**
 * Generate an image using Google's Gemini model via the Generative Language API.
 * Returns the path to the saved image file and any text response.
 */
export async function generateImage(
  prompt: string,
  options?: {
    apiKey?: string;
    model?: string;
    outputPath?: string;
  },
): Promise<{ imagePath: string; text?: string }> {
  const apiKey = options?.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required for image generation. Set it in Settings > Google AI.",
    );
  }

  const model = options?.model ?? process.env.NOMOS_IMAGE_GENERATION_MODEL ?? DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;

  if (!data.candidates?.[0]?.content?.parts) {
    throw new Error("No content returned from Gemini API");
  }

  const parts = data.candidates[0].content.parts;
  let text: string | undefined;
  let imageData: string | undefined;
  let mimeType = "image/png";

  for (const part of parts) {
    if (part.text) {
      text = part.text;
    }
    if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
    }
  }

  if (!imageData) {
    throw new Error("No image was generated. The model returned text only.");
  }

  // Determine file extension from MIME type
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";

  // Save to output path or temp directory
  const fileName = `generated-${randomBytes(4).toString("hex")}${ext}`;
  const outputPath = options?.outputPath ?? join(tmpdir(), fileName);

  const buffer = Buffer.from(imageData, "base64");
  await writeFile(outputPath, buffer);

  return { imagePath: outputPath, text };
}
