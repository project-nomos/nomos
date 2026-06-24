import { getIntegration } from "../db/integrations.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("api-keys");

/**
 * Bridge the Google AI / Gemini API key the Settings UI saves (encrypted in the
 * `google-ai` integration) into process.env, so the code that reads
 * `process.env.GOOGLE_API_KEY` — embeddings (`memory/embeddings.ts`) and Studio
 * image/video gen — actually sees it.
 *
 * The UI writes the key ONLY to the DB (`integrations.google-ai`, secret); nothing
 * else ever copied it into the environment, so setting it in the UI was a silent
 * no-op for embeddings (they fell back to Vertex, which has no ADC, and failed).
 * An explicitly-set env var always wins and is never overridden.
 *
 * Call once at boot AFTER the DB is available (and before any embedding use).
 * Idempotent and best-effort: a missing DB / integration just means no key to load.
 */
export async function hydrateApiKeysFromIntegrations(): Promise<void> {
  // Already provided via the environment (.env / OS env / hosted K8s secret) — done.
  if (process.env.GOOGLE_API_KEY && process.env.GEMINI_API_KEY) return;
  try {
    const integ = await getIntegration("google-ai");
    if (!integ?.enabled) return;
    const key = integ.secrets?.api_key;
    if (typeof key !== "string" || key.length === 0) return;
    if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = key;
    if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = key;
    log.info("Loaded Google AI API key from integrations (Settings UI) into env");
  } catch (err) {
    log.debug({ err }, "Could not hydrate API keys from integrations");
  }
}
