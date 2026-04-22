import { NextResponse } from "next/server";
import { readConfig } from "@/lib/env";
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
  const checks = { database: false, apiKey: false, agentName: false };

  // 1. Check database connectivity
  let sql: ReturnType<typeof getDb> | undefined;
  try {
    sql = getDb();
    await sql`SELECT 1`;
    checks.database = true;
  } catch {
    // DB not connected
  }

  // 2. Check API key — from DB or .env
  const env = await readConfig(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_VERTEX"], sql);
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_VERTEX === "1") {
    checks.apiKey = true;
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
