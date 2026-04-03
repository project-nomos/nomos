import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const CONTEXT_WINDOW = 200_000; // 200K tokens for current models

export async function GET() {
  try {
    const sql = getDb();

    // Get the most recent active session's token breakdown
    const sessions = await sql`
      SELECT
        input_tokens,
        output_tokens,
        model
      FROM sessions
      WHERE input_tokens > 0
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    // Estimate section breakdown from session data
    // These are approximations — exact breakdown requires runtime data
    const session = sessions[0];
    const inputTokens = session ? Number(session.input_tokens) || 0 : 0;
    const outputTokens = session ? Number(session.output_tokens) || 0 : 0;

    // Heuristic breakdown of input tokens
    const systemPromptTokens = Math.min(inputTokens, 8000); // ~8K for system prompt
    const toolSchemaTokens = Math.min(Math.max(0, inputTokens - systemPromptTokens), 12000); // ~12K for tool schemas
    const conversationTokens =
      Math.max(0, inputTokens - systemPromptTokens - toolSchemaTokens) + outputTokens;

    // Check for memory and skills usage from config
    let memoryTokens = 0;
    let skillsTokens = 0;
    try {
      const memoryCount = await sql`SELECT COUNT(*) as count FROM memory_chunks`;
      if (Number(memoryCount[0]?.count) > 0) {
        memoryTokens = 2000; // Estimate ~2K for injected memory context
      }
    } catch {
      // Table may not exist
    }

    try {
      const config = await sql`SELECT value FROM config WHERE key = 'app.skills'`;
      if (config.length > 0) {
        skillsTokens = 1500; // Estimate ~1.5K for skill definitions
      }
    } catch {
      // No skills config
    }

    const sections = [
      {
        label: "System Prompt",
        tokens: systemPromptTokens,
        color: "#89b4fa",
        percent: Math.round((systemPromptTokens / CONTEXT_WINDOW) * 100),
      },
      {
        label: "Conversation",
        tokens: conversationTokens,
        color: "#a6e3a1",
        percent: Math.round((conversationTokens / CONTEXT_WINDOW) * 100),
      },
      {
        label: "Tool Schemas",
        tokens: toolSchemaTokens,
        color: "#f9e2af",
        percent: Math.round((toolSchemaTokens / CONTEXT_WINDOW) * 100),
      },
    ];

    if (memoryTokens > 0) {
      sections.push({
        label: "Memory",
        tokens: memoryTokens,
        color: "#cba6f7",
        percent: Math.round((memoryTokens / CONTEXT_WINDOW) * 100),
      });
    }
    if (skillsTokens > 0) {
      sections.push({
        label: "Skills",
        tokens: skillsTokens,
        color: "#f38ba8",
        percent: Math.round((skillsTokens / CONTEXT_WINDOW) * 100),
      });
    }

    const totalUsed = sections.reduce((sum, s) => sum + s.tokens, 0);
    const remaining = Math.max(0, CONTEXT_WINDOW - totalUsed);

    return NextResponse.json({
      contextWindow: CONTEXT_WINDOW,
      sections,
      totalUsed,
      remaining,
      usagePercent: Math.round((totalUsed / CONTEXT_WINDOW) * 100),
    });
  } catch (err) {
    console.error("Failed to fetch context data:", err);
    // Return sensible defaults
    return NextResponse.json({
      contextWindow: CONTEXT_WINDOW,
      sections: [
        { label: "System Prompt", tokens: 8000, color: "#89b4fa", percent: 4 },
        { label: "Conversation", tokens: 0, color: "#a6e3a1", percent: 0 },
        { label: "Tool Schemas", tokens: 12000, color: "#f9e2af", percent: 6 },
      ],
      totalUsed: 20000,
      remaining: 180000,
      usagePercent: 10,
    });
  }
}
