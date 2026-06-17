/**
 * A/B probe for the studio generative-safety fix. Runs the SAME portrait + edit
 * through the model twice against your real creds (the daemon's surface):
 *
 *   OLD: no config            -> reproduces the `IMAGE_SAFETY` refusal
 *   NEW: relaxed safetySettings (the fix in gemini-image.ts) -> should pass
 *
 * This is the real-run verification the unit tests can't do (the SDK is mocked
 * there). It needs whatever creds the daemon uses (GEMINI_API_KEY / GOOGLE_API_KEY,
 * or GOOGLE_CLOUD_PROJECT + ADC for Vertex). Run it in the SAME shell that runs
 * hosted-google.sh so the env matches.
 *
 * Usage:
 *   pnpm tsx scripts/studio-safety-probe.ts <image-path> ["edit instruction"]
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { createGoogleGenAIImageClient } from "../src/studio/providers/gemini-image.ts";

function surface(): { ai: GoogleGenAI; model: string } {
  const model = process.env.NOMOS_STUDIO_GEMINI_MODEL ?? "gemini-2.5-flash-image";
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const kind = process.env.NOMOS_STUDIO_PROVIDER ?? (apiKey ? "gemini" : "vertex");
  const ai =
    kind === "vertex"
      ? new GoogleGenAI({
          vertexai: true,
          project: process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.CLOUD_ML_REGION ?? "us-central1",
        })
      : new GoogleGenAI({ apiKey });
  console.log(`surface=${kind} model=${model}`);
  return { ai, model };
}

async function rawNoConfig(imageBase64: string, mime: string, prompt: string): Promise<string> {
  const { ai, model } = surface();
  const resp = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: mime, data: imageBase64 } }, { text: prompt }],
      },
    ],
  });
  const cand = resp.candidates?.[0];
  const hasImage = (cand?.content?.parts ?? []).some((p) => p.inlineData?.data);
  return hasImage ? "OK (image returned)" : `REFUSED (${cand?.finishReason ?? "no image"})`;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const prompt =
    process.argv[3] ?? "Subtly even out the skin tone and soften shine. Keep identity.";
  if (!path) {
    console.error("usage: pnpm tsx scripts/studio-safety-probe.ts <image-path> [instruction]");
    process.exit(2);
  }
  const bytes = await readFile(path);
  const mime = path.endsWith(".png") ? "image/png" : "image/jpeg";
  const imageBase64 = bytes.toString("base64");
  console.log(`image=${path} (${bytes.length}B) prompt=${JSON.stringify(prompt)}\n`);

  let oldResult = "n/a";
  try {
    oldResult = await rawNoConfig(imageBase64, mime, prompt);
  } catch (err) {
    oldResult = `ERROR ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`OLD (no safetySettings): ${oldResult}`);

  let newResult = "n/a";
  try {
    const out = await createGoogleGenAIImageClient().editImage({
      imageBase64,
      mimeType: mime,
      prompt,
    });
    newResult = `OK (image returned, ${Buffer.from(out.base64, "base64").length}B)`;
  } catch (err) {
    newResult = `REFUSED/ERROR ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`NEW (relaxed safetySettings): ${newResult}`);

  console.log(
    newResult.startsWith("OK")
      ? "\nSAFETY PROBE: PASS — the fix lets the edit through."
      : "\nSAFETY PROBE: still refused — likely a NON-configurable block (minors / public figure / CSAM) or a different instruction. The error message is now legible end-to-end.",
  );
}

main().catch((err) => {
  console.error("SAFETY PROBE: FAIL", err);
  process.exit(1);
});
