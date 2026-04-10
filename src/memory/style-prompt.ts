/**
 * Style prompt generator.
 *
 * Converts StyleProfile data into natural-language instructions
 * that can be injected into the agent's system prompt.
 */

import { getStyleProfile, type StyleProfile } from "../db/style-profiles.ts";

/**
 * Build style guidance text for the system prompt.
 * Merges global profile with per-contact overrides.
 *
 * @param contact - Optional contact identifier for per-contact style
 * @returns Style guidance string, or empty string if no profiles exist
 */
export async function buildStyleGuidance(contact?: string): Promise<string> {
  const globalRow = await getStyleProfile(null, "global");
  if (!globalRow) return "";

  const global = globalRow.profile as unknown as StyleProfile;

  // Check for per-contact override
  let effective = global;
  if (contact) {
    const contactRow = await getStyleProfile(null, `contact:${contact}`);
    if (contactRow) {
      const contactProfile = contactRow.profile as unknown as StyleProfile;
      effective = mergeProfiles(global, contactProfile);
    }
  }

  return profileToPrompt(effective);
}

/** Merge global + contact profiles (contact overrides non-default values). */
function mergeProfiles(global: StyleProfile, contact: StyleProfile): StyleProfile {
  return {
    formality: contact.formality !== 3 ? contact.formality : global.formality,
    avgLength: contact.avgLength > 0 ? contact.avgLength : global.avgLength,
    emojiUsage: contact.emojiUsage !== "rare" ? contact.emojiUsage : global.emojiUsage,
    punctuation: contact.punctuation !== "standard" ? contact.punctuation : global.punctuation,
    greetingStyle: contact.greetingStyle !== "none" ? contact.greetingStyle : global.greetingStyle,
    signoffStyle: contact.signoffStyle !== "none" ? contact.signoffStyle : global.signoffStyle,
    vocabulary:
      contact.vocabulary.length > 0
        ? [...new Set([...contact.vocabulary, ...global.vocabulary])]
        : global.vocabulary,
    tone: contact.tone !== "neutral" ? contact.tone : global.tone,
    casing: contact.casing !== "standard" ? contact.casing : global.casing,
    responseSpeed:
      contact.responseSpeed !== "moderate" ? contact.responseSpeed : global.responseSpeed,
  };
}

/** Convert a style profile to natural-language prompt instructions. */
function profileToPrompt(profile: StyleProfile): string {
  const lines: string[] = ["## Communication Style"];

  // Formality
  const formalityMap: Record<number, string> = {
    1: "Write very casually — like texting a close friend",
    2: "Write casually — relaxed, informal tone",
    3: "Write in a balanced, conversational tone",
    4: "Write semi-formally — professional but approachable",
    5: "Write formally — polished, professional language",
  };
  lines.push(`- ${formalityMap[profile.formality] ?? formalityMap[3]}`);

  // Length
  if (profile.avgLength < 15) {
    lines.push("- Keep responses brief — short, punchy messages");
  } else if (profile.avgLength < 30) {
    lines.push("- Use moderate message length — concise but complete");
  } else {
    lines.push("- Write more detailed responses when appropriate");
  }

  // Tone
  if (profile.tone !== "neutral") {
    lines.push(`- Maintain a ${profile.tone} tone`);
  }

  // Casing
  if (profile.casing === "lowercase") {
    lines.push("- Use lowercase (no capitalization at start of sentences)");
  }

  // Emoji
  if (profile.emojiUsage === "frequent") {
    lines.push("- Use emojis freely");
  } else if (profile.emojiUsage === "moderate") {
    lines.push("- Occasionally use emojis");
  } else if (profile.emojiUsage === "none") {
    lines.push("- Do not use emojis");
  }

  // Greetings and signoffs
  if (profile.greetingStyle !== "none") {
    lines.push(`- Greet with: "${profile.greetingStyle}"`);
  }
  if (profile.signoffStyle !== "none") {
    lines.push(`- Sign off with: "${profile.signoffStyle}"`);
  }

  // Punctuation
  if (profile.punctuation === "minimal") {
    lines.push("- Use minimal punctuation");
  } else if (profile.punctuation === "expressive") {
    lines.push("- Use expressive punctuation (exclamation marks, ellipses, etc.)");
  }

  // Vocabulary
  if (profile.vocabulary.length > 0) {
    lines.push(`- Characteristic phrases: ${profile.vocabulary.join(", ")}`);
  }

  return lines.join("\n");
}
