import { NextResponse } from "next/server";
import { readEnv } from "@/lib/env";
import { getDb } from "@/lib/db";

export interface SetupStatus {
  complete: boolean;
  /** Current step the user should be on (1-based). 0 if complete. */
  step: number;
  checks: {
    database: boolean;
    apiKey: boolean;
    agentName: boolean;
  };
}

export async function GET() {
  const env = readEnv();
  const checks = { database: false, apiKey: false, agentName: false };

  // 1. Check database connectivity
  try {
    const sql = getDb();
    await sql`SELECT 1`;
    checks.database = true;
  } catch {
    // DB not connected
  }

  // 2. Check API key — from env or DB integrations
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_VERTEX === "1") {
    checks.apiKey = true;
  }
  if (!checks.apiKey && checks.database) {
    try {
      const sql = getDb();
      const [anthropic] = await sql`
        SELECT secrets FROM integrations WHERE name = 'anthropic'
      `;
      if (anthropic?.secrets) checks.apiKey = true;

      if (!checks.apiKey) {
        const [vertex] = await sql`
          SELECT config FROM integrations WHERE name = 'vertex-ai'
        `;
        if (vertex?.config) {
          const cfg = vertex.config as Record<string, unknown>;
          if (cfg.project_id) checks.apiKey = true;
        }
      }
    } catch {
      // integrations table may not exist yet
    }
  }

  // 3. Check agent name — from DB config
  if (checks.database) {
    try {
      const sql = getDb();
      const [row] = await sql`
        SELECT value FROM config WHERE key = 'agent.name'
      `;
      if (row?.value) checks.agentName = true;
    } catch {
      // config table may not exist yet
    }
  }

  // Determine which step the user is on
  let step = 1;
  if (checks.database) step = 2;
  if (checks.database && checks.apiKey) step = 3;
  if (checks.database && checks.apiKey && checks.agentName) step = 4;

  const complete = checks.database && checks.apiKey && checks.agentName;

  return NextResponse.json({ complete, step: complete ? 0 : step, checks });
}
