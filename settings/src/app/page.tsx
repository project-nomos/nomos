import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

async function isSetupComplete(): Promise<boolean> {
  try {
    const sql = getDb();

    // Check DB connection
    await sql`SELECT 1`;

    // Check API key configured
    const [anthropic] = await sql`
      SELECT secrets FROM integrations WHERE name = 'anthropic'
    `;
    const hasAnthropicKey = !!anthropic?.secrets;

    // Check Vertex AI as alternative
    let hasVertexConfig = false;
    if (!hasAnthropicKey) {
      const [vertex] = await sql`
        SELECT config FROM integrations WHERE name = 'vertex-ai'
      `;
      if (vertex?.config) {
        const cfg = vertex.config as Record<string, unknown>;
        hasVertexConfig = !!cfg.project_id;
      }
    }

    // Also check env vars as fallback
    const hasEnvKey =
      !!process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_VERTEX === "1";

    const hasApiKey = hasAnthropicKey || hasVertexConfig || hasEnvKey;

    // Check agent name
    const [nameRow] = await sql`
      SELECT value FROM config WHERE key = 'agent.name'
    `;
    const hasName = !!nameRow?.value;

    return hasApiKey && hasName;
  } catch {
    // DB not available — setup is not complete
    return false;
  }
}

export default async function Home() {
  const complete = await isSetupComplete();
  redirect(complete ? "/dashboard" : "/setup");
}
