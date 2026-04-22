import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "node:fs";
import path from "node:path";

const CONTEXT_WINDOW = 200_000; // 200K tokens for current Claude models
const CHARS_PER_TOKEN = 4; // rough estimate

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function GET() {
  try {
    const sql = getDb();

    // 1. System prompt: estimate from identity, SOUL.md, profile config
    let systemPromptChars = 0;

    // SOUL.md
    const soulPaths = [
      path.resolve(process.cwd(), "..", "SOUL.md"),
      path.resolve(process.cwd(), "..", "SOUL.md.example"),
    ];
    for (const p of soulPaths) {
      if (fs.existsSync(p)) {
        systemPromptChars += fs.readFileSync(p, "utf-8").length;
        break;
      }
    }

    // TOOLS.md
    const toolsMdPath = path.resolve(process.cwd(), "..", "TOOLS.md");
    if (fs.existsSync(toolsMdPath)) {
      systemPromptChars += fs.readFileSync(toolsMdPath, "utf-8").length;
    }

    // Base prompt scaffolding (identity, instructions, permissions, etc.)
    systemPromptChars += 3000; // ~750 tokens of boilerplate

    const systemPromptTokens = estimateTokens(String(systemPromptChars));

    // 2. User model: count entries and estimate tokens
    let userModelTokens = 0;
    try {
      const entries = await sql`
        SELECT category, COUNT(*)::int as cnt,
               SUM(length(value::text))::int as total_chars
        FROM user_model
        GROUP BY category
      `;
      const userModelBreakdown: Record<string, { count: number; chars: number }> = {};
      for (const e of entries) {
        userModelBreakdown[e.category as string] = {
          count: Number(e.cnt),
          chars: Number(e.total_chars) || 0,
        };
        userModelTokens += estimateTokens(String(e.total_chars || 0));
      }
      // Add the section headers and formatting overhead
      userModelTokens += entries.length * 50;
    } catch {
      // Table may not exist
    }

    // 3. Skills: count skill files
    let skillsTokens = 0;
    let skillCount = 0;
    const skillDirs = [
      path.resolve(process.cwd(), "..", "skills"),
      path.join(process.env.HOME ?? "", ".nomos", "skills"),
    ];
    for (const dir of skillDirs) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillFile = path.join(dir, entry.name, "SKILL.md");
              if (fs.existsSync(skillFile)) {
                skillCount++;
                // Skills are injected as name + description (~100 tokens each)
                skillsTokens += 100;
              }
            }
          }
        } catch {
          // Skip unreadable dirs
        }
      }
    }

    // 4. MCP tool schemas: estimate from integrations
    let toolSchemaTokens = 0;
    let mcpServerCount = 0;
    try {
      const integrations = await sql`
        SELECT name FROM integrations WHERE enabled = true
      `;
      // Each MCP server contributes ~500-2000 tokens for tool schemas
      for (const i of integrations) {
        const name = i.name as string;
        if (name.startsWith("slack-ws:") || name === "google" || name.startsWith("google-ws:")) {
          mcpServerCount++;
          toolSchemaTokens += 1500; // workspace MCP servers have many tools
        }
      }
      // Built-in tools (memory_search, user_model_recall, etc.)
      toolSchemaTokens += 800;
      // SDK built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, etc.)
      toolSchemaTokens += 6000;
    } catch {
      toolSchemaTokens = 8000; // fallback estimate
    }

    // 5. Memory: count chunks and estimate injected context
    let memoryTokens = 0;
    let memoryChunkCount = 0;
    try {
      const [mc] = await sql`SELECT COUNT(*)::int as cnt FROM memory_chunks`;
      memoryChunkCount = Number(mc.cnt);
      // Memory search results are injected on demand (~500-2000 tokens per query)
      // Estimate based on conversation memory (auto-indexed)
      if (memoryChunkCount > 0) {
        memoryTokens = Math.min(memoryChunkCount * 2, 4000); // cap at 4K
      }
    } catch {
      // Table may not exist
    }

    // 6. Recent conversation: estimate from transcript messages
    let conversationTokens = 0;
    try {
      const [recent] = await sql`
        SELECT SUM(length(content::text))::int as total_chars
        FROM (
          SELECT content FROM transcript_messages
          ORDER BY created_at DESC
          LIMIT 50
        ) t
      `;
      if (recent?.total_chars) {
        conversationTokens = estimateTokens(String(recent.total_chars));
      }
    } catch {
      // Table may not exist
    }

    const sections = [
      {
        label: "System Prompt",
        tokens: systemPromptTokens,
        color: "#89b4fa",
        percent: Math.round((systemPromptTokens / CONTEXT_WINDOW) * 100),
        detail: "Identity, SOUL.md, TOOLS.md, instructions",
      },
      {
        label: "User Model",
        tokens: userModelTokens,
        color: "#cba6f7",
        percent: Math.round((userModelTokens / CONTEXT_WINDOW) * 100),
        detail: "Decision patterns, values, facts, preferences",
      },
      {
        label: "Tool Schemas",
        tokens: toolSchemaTokens,
        color: "#f9e2af",
        percent: Math.round((toolSchemaTokens / CONTEXT_WINDOW) * 100),
        detail: `SDK tools + ${mcpServerCount} MCP server(s)`,
      },
      {
        label: "Skills",
        tokens: skillsTokens,
        color: "#f38ba8",
        percent: Math.round((skillsTokens / CONTEXT_WINDOW) * 100),
        detail: `${skillCount} skill(s) loaded`,
      },
      {
        label: "Memory",
        tokens: memoryTokens,
        color: "#94e2d5",
        percent: Math.round((memoryTokens / CONTEXT_WINDOW) * 100),
        detail: `${memoryChunkCount.toLocaleString()} chunks indexed`,
      },
      {
        label: "Conversation",
        tokens: conversationTokens,
        color: "#a6e3a1",
        percent: Math.round((conversationTokens / CONTEXT_WINDOW) * 100),
        detail: "Recent message history",
      },
    ].filter((s) => s.tokens > 0);

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
    return NextResponse.json({
      contextWindow: CONTEXT_WINDOW,
      sections: [],
      totalUsed: 0,
      remaining: CONTEXT_WINDOW,
      usagePercent: 0,
    });
  }
}
