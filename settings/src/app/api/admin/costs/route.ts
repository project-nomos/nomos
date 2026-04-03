import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const sql = getDb();

    // Fetch recent sessions with cost data
    const sessions = await sql`
      SELECT
        session_key,
        model,
        COALESCE(total_cost_usd, 0) as total_cost_usd,
        COALESCE(input_tokens, 0) as input_tokens,
        COALESCE(output_tokens, 0) as output_tokens,
        COALESCE(turn_count, 0) as turn_count,
        created_at,
        updated_at
      FROM sessions
      WHERE session_key LIKE 'cli:%'
      ORDER BY updated_at DESC
      LIMIT 50
    `;

    let totalCostUsd = 0;
    let totalTurns = 0;

    const sessionData = sessions.map((s) => {
      const cost = Number(s.total_cost_usd) || 0;
      const turns = Number(s.turn_count) || 0;
      totalCostUsd += cost;
      totalTurns += turns;

      return {
        sessionKey: s.session_key as string,
        model: (s.model as string) || "",
        totalCostUsd: cost,
        totalInputTokens: Number(s.input_tokens) || 0,
        totalOutputTokens: Number(s.output_tokens) || 0,
        totalTurns: turns,
        durationMs: 0,
        modelUsage: {},
        updatedAt: (s.updated_at as Date).toISOString(),
      };
    });

    // Collect distinct models actually used
    const modelsUsed = [...new Set(sessionData.map((s) => s.model).filter(Boolean))];

    // Also check configured model tiers from config table
    try {
      const configRows = await sql`
        SELECT key, value FROM config
        WHERE key IN ('app.model', 'app.modelSimple', 'app.modelModerate', 'app.modelComplex')
      `;
      for (const row of configRows) {
        const val = row.value as string;
        if (val && !modelsUsed.includes(val)) {
          modelsUsed.push(val);
        }
      }
    } catch {
      // Config table may not have these keys
    }

    return NextResponse.json({
      sessions: sessionData,
      totalCostUsd,
      totalSessions: sessionData.length,
      totalTurns,
      modelsUsed,
    });
  } catch (err) {
    console.error("Failed to fetch cost data:", err);
    return NextResponse.json(
      { sessions: [], totalCostUsd: 0, totalSessions: 0, totalTurns: 0 },
      { status: 200 },
    );
  }
}
