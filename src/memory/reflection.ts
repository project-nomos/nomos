/**
 * Reflection Cycles -- generates self-assessment data for the /reflect skill.
 *
 * Analyzes the user model to produce:
 * 1. A synthesis summary of decision patterns, values, and preferences
 * 2. Scenario-specific predictions based on the model
 * 3. Blind spot identification (low-confidence or missing areas)
 *
 * The actual conversational flow is handled by the skill prompt;
 * this module provides the structured data the skill operates on.
 */

import { getUserModel, type UserModelEntry } from "../db/user-model.ts";
import { CALIBRATION_DOMAINS, type CalibrationDomain } from "./calibration.ts";

export interface ReflectionSynthesis {
  decisionStyle: string[];
  coreValues: string[];
  communicationPrefs: string[];
  workingStyle: string[];
  overallConfidence: number;
  entryCount: number;
  domainsCovered: number;
}

export interface ReflectionPrediction {
  scenario: string;
  prediction: string;
  reasoning: string;
  confidence: number;
  basedOn: string[];
}

export interface ReflectionBlindSpot {
  area: string;
  reason: string;
  /** Suggested question to fill this gap. */
  suggestedProbe: string;
}

export interface ReflectionData {
  synthesis: ReflectionSynthesis;
  predictions: ReflectionPrediction[];
  blindSpots: ReflectionBlindSpot[];
  /** Raw entries for the skill to reference if needed. */
  patternCount: number;
  valueCount: number;
  preferenceCount: number;
  factCount: number;
}

/**
 * Generate reflection data from the current user model.
 */
export async function generateReflectionData(): Promise<ReflectionData> {
  let entries: UserModelEntry[];
  try {
    entries = await getUserModel();
  } catch {
    entries = [];
  }

  const patterns = entries.filter((e) => e.category === "decision_pattern");
  const values = entries.filter((e) => e.category === "value");
  const preferences = entries.filter((e) => e.category === "preference");
  const facts = entries.filter((e) => e.category === "fact");

  const synthesis = buildSynthesis(patterns, values, preferences);
  const predictions = generatePredictions(patterns, values);
  const blindSpots = identifyBlindSpots(patterns, values, preferences, facts);

  return {
    synthesis,
    predictions,
    blindSpots,
    patternCount: patterns.length,
    valueCount: values.length,
    preferenceCount: preferences.length,
    factCount: facts.length,
  };
}

function buildSynthesis(
  patterns: UserModelEntry[],
  values: UserModelEntry[],
  preferences: UserModelEntry[],
): ReflectionSynthesis {
  const decisionStyle: string[] = [];
  const coreValues: string[] = [];
  const communicationPrefs: string[] = [];
  const workingStyle: string[] = [];

  // Extract decision style from top patterns
  const topPatterns = [...patterns].sort((a, b) => {
    const aw = (a.value as { weight?: number })?.weight ?? 0;
    const bw = (b.value as { weight?: number })?.weight ?? 0;
    return bw - aw;
  });

  for (const p of topPatterns.slice(0, 10)) {
    const v = p.value as { principle: string; context: string };
    decisionStyle.push(`${v.principle} (context: ${v.context || "general"})`);
  }

  // Extract core values sorted by confidence
  const sortedValues = [...values].sort((a, b) => b.confidence - a.confidence);
  for (const val of sortedValues.slice(0, 10)) {
    const v = val.value as { value: string; description: string };
    coreValues.push(`${v.value}: ${v.description}`);
  }

  // Extract communication preferences
  for (const pref of preferences) {
    const key = pref.key.toLowerCase();
    if (
      key.includes("communi") ||
      key.includes("message") ||
      key.includes("tone") ||
      key.includes("style") ||
      key.includes("writing") ||
      key.includes("response")
    ) {
      communicationPrefs.push(`${pref.key}: ${JSON.stringify(pref.value)}`);
    }
  }

  // Working style from remaining preferences and patterns
  for (const pref of preferences) {
    const key = pref.key.toLowerCase();
    if (
      key.includes("work") ||
      key.includes("tool") ||
      key.includes("editor") ||
      key.includes("schedule") ||
      key.includes("focus")
    ) {
      workingStyle.push(`${pref.key}: ${JSON.stringify(pref.value)}`);
    }
  }

  // Calculate overall confidence
  const allEntries = [...patterns, ...values, ...preferences];
  const overallConfidence =
    allEntries.length > 0
      ? allEntries.reduce((sum, e) => sum + e.confidence, 0) / allEntries.length
      : 0;

  // Count covered domains
  const coveredDomains = new Set<string>();
  for (const entry of [...patterns, ...values]) {
    const val = entry.value as Record<string, unknown>;
    const context = ((val.context as string) ?? "").toLowerCase();
    const key = entry.key.toLowerCase();
    for (const domain of CALIBRATION_DOMAINS) {
      if (context.includes(domain) || key.includes(domain)) {
        coveredDomains.add(domain);
      }
    }
  }

  return {
    decisionStyle,
    coreValues,
    communicationPrefs,
    workingStyle,
    overallConfidence: Math.round(overallConfidence * 100) / 100,
    entryCount: allEntries.length,
    domainsCovered: coveredDomains.size,
  };
}

/**
 * Generate predictions by finding pairs of patterns/values that might conflict,
 * or by extrapolating patterns to novel scenarios.
 */
function generatePredictions(
  patterns: UserModelEntry[],
  values: UserModelEntry[],
): ReflectionPrediction[] {
  const predictions: ReflectionPrediction[] = [];
  const highConfPatterns = patterns
    .filter((p) => p.confidence >= 0.6)
    .sort((a, b) => {
      const aw = (a.value as { weight?: number })?.weight ?? 0;
      const bw = (b.value as { weight?: number })?.weight ?? 0;
      return bw - aw;
    });
  const highConfValues = values.filter((v) => v.confidence >= 0.6);

  // Prediction type 1: Apply top patterns to novel scenarios
  for (const p of highConfPatterns.slice(0, 3)) {
    const v = p.value as {
      principle: string;
      context: string;
      weight: number;
      exceptions: string[];
    };
    const scenario = NOVEL_SCENARIOS[v.context] ?? NOVEL_SCENARIOS.general;
    if (scenario) {
      predictions.push({
        scenario: scenario.scenario,
        prediction: `You'd lean toward: ${v.principle}`,
        reasoning: `This matches your pattern in ${v.context || "general"} contexts (weight: ${v.weight})`,
        confidence: Math.round(p.confidence * v.weight * 100) / 100,
        basedOn: [p.key],
      });
    }
  }

  // Prediction type 2: Value conflict scenarios
  if (highConfValues.length >= 2) {
    for (let i = 0; i < Math.min(highConfValues.length - 1, 2); i++) {
      const v1 = highConfValues[i]!.value as { value: string; description: string };
      const v2 = highConfValues[i + 1]!.value as { value: string; description: string };
      const higher = highConfValues[i]!.confidence >= highConfValues[i + 1]!.confidence ? v1 : v2;

      predictions.push({
        scenario: `A situation where "${v1.value}" and "${v2.value}" pull in opposite directions`,
        prediction: `You'd prioritize "${higher.value}" based on the relative confidence levels`,
        reasoning: `${v1.value} (${(highConfValues[i]!.confidence * 100).toFixed(0)}%) vs ${v2.value} (${(highConfValues[i + 1]!.confidence * 100).toFixed(0)}%)`,
        confidence: Math.abs(highConfValues[i]!.confidence - highConfValues[i + 1]!.confidence),
        basedOn: [highConfValues[i]!.key, highConfValues[i + 1]!.key],
      });
    }
  }

  return predictions.slice(0, 5);
}

/**
 * Identify areas where the user model is weak.
 */
function identifyBlindSpots(
  patterns: UserModelEntry[],
  values: UserModelEntry[],
  preferences: UserModelEntry[],
  facts: UserModelEntry[],
): ReflectionBlindSpot[] {
  const blindSpots: ReflectionBlindSpot[] = [];

  // Check for uncovered calibration domains
  const coveredDomains = new Set<string>();
  for (const entry of [...patterns, ...values]) {
    const val = entry.value as Record<string, unknown>;
    const context = ((val.context as string) ?? "").toLowerCase();
    const key = entry.key.toLowerCase();
    for (const domain of CALIBRATION_DOMAINS) {
      if (context.includes(domain) || key.includes(domain)) {
        coveredDomains.add(domain);
      }
    }
  }

  const uncoveredDomains = CALIBRATION_DOMAINS.filter((d) => !coveredDomains.has(d));
  for (const domain of uncoveredDomains.slice(0, 3)) {
    const name = domain
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    blindSpots.push({
      area: name,
      reason: `No decision patterns or values recorded for this domain`,
      suggestedProbe:
        DOMAIN_PROBES[domain] ?? `How do you approach ${name.toLowerCase()} decisions?`,
    });
  }

  // Check for low-confidence entries that need validation
  const lowConf = [...patterns, ...values].filter((e) => e.confidence > 0.3 && e.confidence < 0.6);
  if (lowConf.length > 0) {
    const entry = lowConf[0]!;
    const label =
      entry.category === "decision_pattern"
        ? (entry.value as { principle: string }).principle
        : (entry.value as { value: string }).value;
    blindSpots.push({
      area: "Low-confidence pattern",
      reason: `"${label}" has only ${(entry.confidence * 100).toFixed(0)}% confidence -- needs more evidence`,
      suggestedProbe: `Can you tell me more about how you approach situations involving "${label}"?`,
    });
  }

  // Check for stale entries (updated > 30 days ago)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const stale = [...patterns, ...values, ...preferences, ...facts].filter(
    (e) => e.updatedAt < thirtyDaysAgo,
  );
  if (stale.length >= 3) {
    blindSpots.push({
      area: "Stale data",
      reason: `${stale.length} entries haven't been updated in over 30 days -- they may not reflect your current thinking`,
      suggestedProbe: "Have any of your work habits or priorities shifted recently?",
    });
  }

  return blindSpots.slice(0, 5);
}

// ── Novel scenario templates for prediction generation ──

const NOVEL_SCENARIOS: Record<string, { scenario: string } | undefined> = {
  general: {
    scenario: "You're given a new project with ambiguous requirements and a tight timeline",
  },
  tech: {
    scenario:
      "You need to choose between a cutting-edge technology with limited community support and a mature but less elegant alternative",
  },
  architecture: {
    scenario:
      "Your team is debating whether to build a monolith or microservices for a new product",
  },
  prioritization: {
    scenario:
      "Three equally important things land on your plate at the same time and you can only finish one today",
  },
  communication: {
    scenario: "A stakeholder asks for an urgent update on something that isn't going well",
  },
  leadership: {
    scenario:
      "A team member pushes back on your technical direction with a valid alternative you hadn't considered",
  },
  quality: {
    scenario:
      "You discover a significant bug in a feature that just shipped but nobody has noticed yet",
  },
  risk: {
    scenario:
      "You have a chance to deploy a high-impact fix on a Friday afternoon before a holiday weekend",
  },
  collaboration: {
    scenario: "A colleague offers to take over a piece of work you've been struggling with",
  },
  coding: {
    scenario:
      "You find yourself writing the same boilerplate for the third time and wonder if it's time to abstract",
  },
};

const DOMAIN_PROBES: Record<CalibrationDomain, string> = {
  tech_decisions: "How do you typically evaluate new technologies before adopting them?",
  communication: "Do you prefer to over-communicate or keep updates minimal?",
  conflict: "When you disagree with a colleague on a technical approach, what do you usually do?",
  prioritization: "How do you decide what to work on when everything feels urgent?",
  leadership: "How comfortable are you delegating work that you could do faster yourself?",
  quality: "Where do you draw the line between 'good enough' and 'done right'?",
  collaboration: "Do you generally prefer working alone or with others?",
  risk: "How do you evaluate whether a risk is worth taking?",
  creativity:
    "When you have an unconventional idea, do you usually propose it or go with the safe choice?",
  time_management: "How do you protect your focus time from interruptions?",
};
