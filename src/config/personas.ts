/**
 * Contextual Personas -- multi-role identity switching.
 *
 * The user is different people in different contexts. This module manages
 * named personas that activate based on platform, contact, channel, or time.
 *
 * Persona detection runs before each agent response. When a persona matches,
 * its style overrides, value weight shifts, and decision pattern overrides
 * are injected into the system prompt for that message.
 *
 * Blending: when context is ambiguous, multiple personas can contribute with
 * weighted influence rather than hard-switching.
 */

import { getConfigValue, setConfigValue } from "../db/config.ts";

// ── Types ──

export interface PersonaTrigger {
  /** Match specific platform(s). */
  platforms?: string[];
  /** Match specific channel IDs or names. */
  channels?: string[];
  /** Match specific user/contact identifiers. */
  contacts?: string[];
  /** Match time-of-day ranges (24h format, e.g. "09:00-17:00"). */
  timeRanges?: string[];
  /** Match keywords in the message content. */
  keywords?: string[];
}

export interface PersonaOverrides {
  /** Tone override (e.g. "professional", "casual", "warm"). */
  tone?: string;
  /** Formality level (1-5, where 1 is very casual and 5 is very formal). */
  formality?: number;
  /** Response length preference. */
  responseLength?: "brief" | "moderate" | "detailed";
  /** Emoji usage. */
  emojiUsage?: "none" | "rare" | "moderate" | "frequent";
  /** Custom style instructions for this persona. */
  styleInstructions?: string;
  /** Value weight adjustments (value key -> weight multiplier). */
  valueWeights?: Record<string, number>;
  /** Decision pattern overrides (pattern key -> override principle). */
  patternOverrides?: Record<string, string>;
  /** Exemplar context filter -- only use exemplars matching these contexts. */
  exemplarContexts?: string[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  triggers: PersonaTrigger;
  overrides: PersonaOverrides;
  /** Priority for disambiguation when multiple personas match (higher = preferred). */
  priority: number;
  enabled: boolean;
}

export interface PersonaMatch {
  persona: Persona;
  /** 0-1 match score based on how many triggers fired. */
  score: number;
}

export interface MessageContext {
  platform: string;
  channelId: string;
  userId: string;
  content: string;
  timestamp: Date;
}

// ── Config key for persona storage ──

const PERSONAS_CONFIG_KEY = "personas.list";

// ── CRUD ──

/**
 * Load all personas from config.
 */
export async function loadPersonas(): Promise<Persona[]> {
  try {
    const stored = await getConfigValue<Persona[]>(PERSONAS_CONFIG_KEY);
    return stored ?? [];
  } catch {
    return [];
  }
}

/**
 * Save personas to config.
 */
export async function savePersonas(personas: Persona[]): Promise<void> {
  await setConfigValue(PERSONAS_CONFIG_KEY, personas);
}

/**
 * Add or update a persona.
 */
export async function upsertPersona(persona: Persona): Promise<void> {
  const personas = await loadPersonas();
  const idx = personas.findIndex((p) => p.id === persona.id);
  if (idx >= 0) {
    personas[idx] = persona;
  } else {
    personas.push(persona);
  }
  await savePersonas(personas);
}

/**
 * Delete a persona by ID.
 */
export async function deletePersona(id: string): Promise<boolean> {
  const personas = await loadPersonas();
  const filtered = personas.filter((p) => p.id !== id);
  if (filtered.length === personas.length) return false;
  await savePersonas(filtered);
  return true;
}

// ── Detection ──

/**
 * Detect which persona(s) match the current message context.
 * Returns matches sorted by score (highest first).
 */
export function detectPersona(personas: Persona[], context: MessageContext): PersonaMatch[] {
  const matches: PersonaMatch[] = [];

  for (const persona of personas) {
    if (!persona.enabled) continue;

    const score = scoreTriggers(persona.triggers, context);
    if (score > 0) {
      matches.push({ persona, score });
    }
  }

  // Sort by score descending, then by priority descending
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.persona.priority - a.persona.priority;
  });

  return matches;
}

/**
 * Score how well triggers match the context.
 * Returns 0 if no triggers match, 0-1 based on proportion of matching triggers.
 */
function scoreTriggers(triggers: PersonaTrigger, context: MessageContext): number {
  let totalCriteria = 0;
  let matchedCriteria = 0;

  if (triggers.platforms && triggers.platforms.length > 0) {
    totalCriteria++;
    if (triggers.platforms.some((p) => context.platform.toLowerCase() === p.toLowerCase())) {
      matchedCriteria++;
    } else {
      // Platform is a hard filter -- wrong platform means no match
      return 0;
    }
  }

  if (triggers.channels && triggers.channels.length > 0) {
    totalCriteria++;
    if (triggers.channels.some((c) => context.channelId.toLowerCase().includes(c.toLowerCase()))) {
      matchedCriteria++;
    }
  }

  if (triggers.contacts && triggers.contacts.length > 0) {
    totalCriteria++;
    if (triggers.contacts.some((c) => context.userId.toLowerCase() === c.toLowerCase())) {
      matchedCriteria++;
    }
  }

  if (triggers.timeRanges && triggers.timeRanges.length > 0) {
    totalCriteria++;
    if (triggers.timeRanges.some((range) => isInTimeRange(context.timestamp, range))) {
      matchedCriteria++;
    }
  }

  if (triggers.keywords && triggers.keywords.length > 0) {
    totalCriteria++;
    const lower = context.content.toLowerCase();
    if (triggers.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      matchedCriteria++;
    }
  }

  if (totalCriteria === 0) return 0;
  return matchedCriteria / totalCriteria;
}

/**
 * Check if a timestamp falls within a time range (e.g. "09:00-17:00").
 */
function isInTimeRange(timestamp: Date, range: string): boolean {
  const match = range.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return false;

  const startHour = parseInt(match[1]!, 10);
  const startMin = parseInt(match[2]!, 10);
  const endHour = parseInt(match[3]!, 10);
  const endMin = parseInt(match[4]!, 10);

  const hour = timestamp.getHours();
  const min = timestamp.getMinutes();
  const current = hour * 60 + min;
  const start = startHour * 60 + startMin;
  const end = endHour * 60 + endMin;

  // Handle ranges that cross midnight (e.g. "22:00-06:00")
  if (start <= end) {
    return current >= start && current <= end;
  }
  return current >= start || current <= end;
}

// ── System Prompt Injection ──

/**
 * Build the persona section for the system prompt.
 * Supports blending: if multiple personas match, their overrides are merged
 * with the highest-scoring persona taking precedence.
 */
export function buildPersonaPrompt(matches: PersonaMatch[]): string {
  if (matches.length === 0) return "";

  const primary = matches[0]!;
  const overrides = blendOverrides(matches);

  const lines: string[] = [
    `## Active Persona: ${primary.persona.name}`,
    primary.persona.description,
    "",
  ];

  if (matches.length > 1) {
    const blendNames = matches
      .slice(1, 3)
      .map((m) => `${m.persona.name} (${(m.score * 100).toFixed(0)}%)`)
      .join(", ");
    lines.push(`_Blending with: ${blendNames}_`);
    lines.push("");
  }

  // Style overrides
  const styleLines: string[] = [];
  if (overrides.tone) styleLines.push(`Tone: ${overrides.tone}`);
  if (overrides.formality != null) {
    const fLabels = ["very casual", "casual", "balanced", "formal", "very formal"];
    styleLines.push(`Formality: ${fLabels[overrides.formality - 1] ?? "balanced"}`);
  }
  if (overrides.responseLength) styleLines.push(`Response length: ${overrides.responseLength}`);
  if (overrides.emojiUsage) styleLines.push(`Emoji usage: ${overrides.emojiUsage}`);
  if (overrides.styleInstructions) styleLines.push(overrides.styleInstructions);

  if (styleLines.length > 0) {
    lines.push("**Style adjustments:**");
    for (const sl of styleLines) {
      lines.push(`- ${sl}`);
    }
    lines.push("");
  }

  // Value weight adjustments
  if (overrides.valueWeights && Object.keys(overrides.valueWeights).length > 0) {
    lines.push("**Value adjustments for this context:**");
    for (const [key, weight] of Object.entries(overrides.valueWeights)) {
      const label = weight > 1 ? "emphasize" : weight < 1 ? "de-emphasize" : "normal";
      lines.push(`- ${key}: ${label} (${weight}x)`);
    }
    lines.push("");
  }

  // Pattern overrides
  if (overrides.patternOverrides && Object.keys(overrides.patternOverrides).length > 0) {
    lines.push("**Decision pattern adjustments:**");
    for (const [key, override] of Object.entries(overrides.patternOverrides)) {
      lines.push(`- ${key}: ${override}`);
    }
    lines.push("");
  }

  lines.push(
    "Adapt your behavior to match this persona while maintaining the user's core identity. Persona adjustments are contextual -- they modify HOW you express the user's values, not WHAT the values are.",
  );

  return lines.join("\n");
}

/**
 * Blend overrides from multiple matching personas.
 * Primary persona (highest score) takes precedence; secondary personas
 * fill in gaps where the primary doesn't specify.
 */
function blendOverrides(matches: PersonaMatch[]): PersonaOverrides {
  const result: PersonaOverrides = {};

  for (const match of matches) {
    const o = match.persona.overrides;
    if (o.tone && !result.tone) result.tone = o.tone;
    if (o.formality != null && result.formality == null) result.formality = o.formality;
    if (o.responseLength && !result.responseLength) result.responseLength = o.responseLength;
    if (o.emojiUsage && !result.emojiUsage) result.emojiUsage = o.emojiUsage;
    if (o.styleInstructions && !result.styleInstructions) {
      result.styleInstructions = o.styleInstructions;
    }

    // Merge value weights (primary weights take precedence on conflict)
    if (o.valueWeights) {
      result.valueWeights = result.valueWeights ?? {};
      for (const [k, v] of Object.entries(o.valueWeights)) {
        if (!(k in result.valueWeights)) {
          result.valueWeights[k] = v;
        }
      }
    }

    // Merge pattern overrides (primary takes precedence on conflict)
    if (o.patternOverrides) {
      result.patternOverrides = result.patternOverrides ?? {};
      for (const [k, v] of Object.entries(o.patternOverrides)) {
        if (!(k in result.patternOverrides)) {
          result.patternOverrides[k] = v;
        }
      }
    }

    // Merge exemplar contexts (union)
    if (o.exemplarContexts) {
      result.exemplarContexts = result.exemplarContexts ?? [];
      for (const ctx of o.exemplarContexts) {
        if (!result.exemplarContexts.includes(ctx)) {
          result.exemplarContexts.push(ctx);
        }
      }
    }
  }

  return result;
}

// ── Default Persona Templates ──

/**
 * Suggested starter personas that users can customize.
 * Not auto-created -- surfaced in the Settings UI and /calibrate.
 */
export const PERSONA_TEMPLATES: Omit<Persona, "id">[] = [
  {
    name: "Work",
    description:
      "Professional context -- meetings, code reviews, stakeholder communication. Prioritize clarity and thoroughness.",
    triggers: {
      platforms: ["slack"],
      timeRanges: ["09:00-18:00"],
    },
    overrides: {
      tone: "professional",
      formality: 4,
      responseLength: "moderate",
      emojiUsage: "rare",
    },
    priority: 5,
    enabled: true,
  },
  {
    name: "Casual",
    description:
      "Personal conversations -- friends, family, off-hours. Be relaxed, use humor, keep it brief.",
    triggers: {
      platforms: ["imessage", "whatsapp"],
      timeRanges: ["18:00-09:00"],
    },
    overrides: {
      tone: "warm",
      formality: 2,
      responseLength: "brief",
      emojiUsage: "moderate",
    },
    priority: 3,
    enabled: true,
  },
  {
    name: "Technical",
    description:
      "Code discussions, architecture decisions, debugging. Be precise, use technical vocabulary, show reasoning.",
    triggers: {
      platforms: ["slack", "discord"],
      keywords: ["bug", "deploy", "PR", "review", "refactor", "API", "endpoint"],
    },
    overrides: {
      tone: "direct",
      formality: 3,
      responseLength: "detailed",
      emojiUsage: "none",
      styleInstructions:
        "Use code blocks for technical details. Reference specific files and line numbers. Be precise about trade-offs.",
    },
    priority: 7,
    enabled: true,
  },
  {
    name: "Leadership",
    description:
      "Managing up/down -- 1:1s, team updates, cross-functional communication. Balance empathy with decisiveness.",
    triggers: {
      keywords: ["team", "sprint", "standup", "1:1", "retro", "roadmap", "OKR"],
    },
    overrides: {
      tone: "warm",
      formality: 3,
      responseLength: "moderate",
      emojiUsage: "rare",
      styleInstructions:
        "Lead with empathy, then clarity. Ask questions before making statements. Acknowledge others' contributions.",
    },
    priority: 6,
    enabled: true,
  },
];
