/**
 * Session memory — structured notes that persist across compaction.
 *
 * Adapted from Claude Code's SessionMemory service. Maintains a structured
 * markdown document with 9 sections that capture the essential state of a
 * working session. Updated automatically after significant turns and
 * injected into compacted conversations to preserve context.
 *
 * The template and update prompt can be customized per-user via files
 * in ~/.nomos/session-memory/config/.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Maximum tokens per section before truncation warning. */
const MAX_SECTION_LENGTH = 2000;

/** Maximum total tokens for session memory before budget warning. */
const MAX_TOTAL_TOKENS = 12000;

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task Specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key Results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

const UPDATE_PROMPT_TEMPLATE = `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt or any past session summaries), update the session notes.

Here are the current session notes:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to update the notes content, then stop.

CRITICAL RULES:
- The notes must maintain the exact structure with all sections and headers intact
- NEVER modify, delete, or add section headers (lines starting with '#')
- NEVER modify the italic _section description_ lines (template instructions)
- ONLY update the actual content that appears BELOW the italic descriptions
- Do NOT add any new sections or information outside the existing structure
- It's OK to skip updating a section if there are no substantial new insights
- Write DETAILED, INFO-DENSE content — include file paths, function names, error messages, exact commands
- Keep each section under ~${MAX_SECTION_LENGTH} tokens — condense older entries if approaching limit
- Focus on actionable, specific information
- ALWAYS update "Current State" to reflect the most recent work

STRUCTURE PRESERVATION REMINDER:
Each section has TWO parts that must be preserved:
1. The section header (line starting with #)
2. The italic description line (the _italicized text_ — this is a template instruction)
You ONLY update the actual content that comes AFTER these two preserved lines.`;

/** Get the nomos config directory for session memory. */
function getSessionMemoryDir(): string {
  return join(homedir(), ".nomos", "session-memory");
}

/** Get the path for a session's memory file. */
export function getSessionMemoryPath(sessionKey: string): string {
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(getSessionMemoryDir(), `${safeKey}.md`);
}

/** Load or create session memory for a session. */
export async function loadSessionMemory(sessionKey: string): Promise<string> {
  const memoryPath = getSessionMemoryPath(sessionKey);

  try {
    return await readFile(memoryPath, "utf-8");
  } catch {
    // No existing memory — return the template
    return await loadTemplate();
  }
}

/** Save session memory. */
export async function saveSessionMemory(sessionKey: string, content: string): Promise<void> {
  const memoryPath = getSessionMemoryPath(sessionKey);
  await mkdir(dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, content, "utf-8");
}

/** Load custom template or fall back to default. */
async function loadTemplate(): Promise<string> {
  const customPath = join(getSessionMemoryDir(), "config", "template.md");

  try {
    return await readFile(customPath, "utf-8");
  } catch {
    return DEFAULT_SESSION_MEMORY_TEMPLATE;
  }
}

/** Load custom update prompt or fall back to default. */
async function loadUpdatePrompt(): Promise<string> {
  const customPath = join(getSessionMemoryDir(), "config", "prompt.md");

  try {
    return await readFile(customPath, "utf-8");
  } catch {
    return UPDATE_PROMPT_TEMPLATE;
  }
}

/** Build the update prompt with variable substitution. */
export async function buildSessionMemoryUpdatePrompt(currentNotes: string): Promise<string> {
  const template = await loadUpdatePrompt();

  // Substitute variables
  let prompt = template.replace(/\{\{currentNotes\}\}/g, currentNotes);

  // Analyze sections and add warnings if oversized
  const sectionSizes = analyzeSectionSizes(currentNotes);
  const totalTokens = roughTokenCount(currentNotes);
  const warnings = generateSizeWarnings(sectionSizes, totalTokens);

  if (warnings) {
    prompt += warnings;
  }

  return prompt;
}

/** Check if session memory is empty (just the template). */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = await loadTemplate();
  return content.trim() === template.trim();
}

/** Truncate oversized sections for inclusion in compact messages. */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string;
  wasTruncated: boolean;
} {
  const lines = content.split("\n");
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4;
  const outputLines: string[] = [];
  let currentSectionLines: string[] = [];
  let currentSectionHeader = "";
  let wasTruncated = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      const result = flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
      outputLines.push(...result.lines);
      wasTruncated = wasTruncated || result.wasTruncated;
      currentSectionHeader = line;
      currentSectionLines = [];
    } else {
      currentSectionLines.push(line);
    }
  }

  // Flush last section
  const result = flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
  outputLines.push(...result.lines);
  wasTruncated = wasTruncated || result.wasTruncated;

  return { truncatedContent: outputLines.join("\n"), wasTruncated };
}

// ── Internal helpers ──

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {};
  const lines = content.split("\n");
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = roughTokenCount(currentContent.join("\n").trim());
      }
      currentSection = line;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection && currentContent.length > 0) {
    sections[currentSection] = roughTokenCount(currentContent.join("\n").trim());
  }

  return sections;
}

function generateSizeWarnings(sectionSizes: Record<string, number>, totalTokens: number): string {
  const overBudget = totalTokens > MAX_TOTAL_TOKENS;
  const oversized = Object.entries(sectionSizes)
    .filter(([, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([section, tokens]) => `- "${section}" is ~${tokens} tokens (limit: ${MAX_SECTION_LENGTH})`,
    );

  if (oversized.length === 0 && !overBudget) return "";

  const parts: string[] = [];

  if (overBudget) {
    parts.push(
      `\n\nCRITICAL: The session memory file is currently ~${totalTokens} tokens, which exceeds the maximum of ${MAX_TOTAL_TOKENS} tokens. You MUST condense the file to fit within this budget. Aggressively shorten oversized sections by removing less important details, merging related items, and summarizing older entries. Prioritize keeping "Current State" and "Errors & Corrections" accurate and detailed.`,
    );
  }

  if (oversized.length > 0) {
    parts.push(
      `\n\n${overBudget ? "Oversized sections to condense" : "IMPORTANT: The following sections exceed the per-section limit and MUST be condensed"}:\n${oversized.join("\n")}`,
    );
  }

  return parts.join("");
}

function flushSection(
  header: string,
  lines: string[],
  maxChars: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!header) return { lines, wasTruncated: false };

  const content = lines.join("\n");
  if (content.length <= maxChars) {
    return { lines: [header, ...lines], wasTruncated: false };
  }

  let charCount = 0;
  const kept: string[] = [header];
  for (const line of lines) {
    if (charCount + line.length + 1 > maxChars) break;
    kept.push(line);
    charCount += line.length + 1;
  }
  kept.push("\n[... section truncated for length ...]");
  return { lines: kept, wasTruncated: true };
}
