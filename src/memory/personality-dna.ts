/**
 * Personality DNA -- compact portable identity document.
 *
 * Compiles the user model, style profiles, and exemplars into a single
 * ~2000-token JSON document that can be exported, versioned, and used
 * to cold-start a new instance.
 *
 * Compression strategy: top 10 decision patterns (by weight),
 * top 5 values (by confidence), compressed style genome,
 * and 3-5 exemplar fingerprints.
 */

import { homedir } from "node:os";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getUserModel, upsertUserModel, type UserModelEntry } from "../db/user-model.ts";
import { getPersonalityDocument, upsertPersonalityDocument } from "../db/personality-documents.ts";

// ── Types ──

export interface PersonalityDNA {
  version: string;
  compiledAt: string;
  identity: {
    summary: string;
    roles: string[];
    expertise: string[];
  };
  decisionPatterns: DNAPattern[];
  values: DNAValue[];
  styleGenome: DNAStyleGenome;
  behavioralSignatures: Record<string, string>;
  exemplarFingerprints: DNAExemplar[];
}

export interface DNAPattern {
  principle: string;
  context: string;
  weight: number;
  exceptions: string[];
}

export interface DNAValue {
  value: string;
  description: string;
  rank: number;
}

export interface DNAStyleGenome {
  formality: number;
  tone: string;
  avgLength: string;
  emojiUsage: string;
  vocabularyMarkers: string[];
  punctuationStyle: string;
  signaturePhrases: string[];
}

export interface DNAExemplar {
  text: string;
  context: string;
}

export interface CompilationResult {
  dna: PersonalityDNA;
  stats: {
    totalPatterns: number;
    includedPatterns: number;
    totalValues: number;
    includedValues: number;
    totalExemplars: number;
    includedExemplars: number;
    estimatedTokens: number;
  };
}

// ── Constants ──

const DNA_VERSION = "1.0";
const DNA_FILE = "personality-dna.json";
const MAX_PATTERNS = 10;
const MAX_VALUES = 5;
const MAX_EXEMPLARS = 5;

function getDnaPath(): string {
  return join(homedir(), ".nomos", DNA_FILE);
}

// ── Compilation ──

/**
 * Compile the personality DNA from all available data sources.
 */
export async function compileDNA(): Promise<CompilationResult> {
  let entries: UserModelEntry[];
  try {
    entries = await getUserModel(resolveMemoryUserId(undefined));
  } catch {
    entries = [];
  }

  const patterns = entries.filter((e) => e.category === "decision_pattern");
  const values = entries.filter((e) => e.category === "value");
  const preferences = entries.filter((e) => e.category === "preference");
  const facts = entries.filter((e) => e.category === "fact");

  // Compile decision patterns (top N by weight)
  const sortedPatterns = [...patterns].sort((a, b) => {
    const aw = (a.value as { weight?: number })?.weight ?? 0;
    const bw = (b.value as { weight?: number })?.weight ?? 0;
    return bw - aw;
  });

  const dnaPatterns: DNAPattern[] = sortedPatterns.slice(0, MAX_PATTERNS).map((p) => {
    const v = p.value as {
      principle: string;
      context: string;
      weight: number;
      exceptions: string[];
    };
    return {
      principle: v.principle,
      context: v.context ?? "general",
      weight: v.weight,
      exceptions: (v.exceptions ?? []).slice(0, 3),
    };
  });

  // Compile values (top N by confidence)
  const sortedValues = [...values].sort((a, b) => b.confidence - a.confidence);
  const dnaValues: DNAValue[] = sortedValues.slice(0, MAX_VALUES).map((v, i) => {
    const val = v.value as { value: string; description: string };
    return {
      value: val.value,
      description: val.description,
      rank: i + 1,
    };
  });

  // Compile style genome from preferences
  const styleGenome = extractStyleGenome(preferences);

  // Compile behavioral signatures from patterns and preferences
  const behavioralSignatures = extractBehavioralSignatures(patterns, preferences);

  // Compile identity summary from facts
  const identity = extractIdentitySummary(facts);

  // Compile exemplar fingerprints from exemplar-tagged entries
  const exemplarEntries = entries.filter((e) => e.category === "exemplar");
  const exemplarFingerprints: DNAExemplar[] = exemplarEntries.slice(0, MAX_EXEMPLARS).map((e) => {
    const val = e.value as { text?: string; context?: string };
    return {
      text: (val.text ?? String(e.value)).slice(0, 200),
      context: val.context ?? "general",
    };
  });

  const dna: PersonalityDNA = {
    version: DNA_VERSION,
    compiledAt: new Date().toISOString(),
    identity,
    decisionPatterns: dnaPatterns,
    values: dnaValues,
    styleGenome,
    behavioralSignatures,
    exemplarFingerprints,
  };

  // Estimate token count (rough: ~4 chars per token for JSON)
  const jsonStr = JSON.stringify(dna, null, 2);
  const estimatedTokens = Math.ceil(jsonStr.length / 4);

  return {
    dna,
    stats: {
      totalPatterns: patterns.length,
      includedPatterns: dnaPatterns.length,
      totalValues: values.length,
      includedValues: dnaValues.length,
      totalExemplars: exemplarEntries.length,
      includedExemplars: exemplarFingerprints.length,
      estimatedTokens,
    },
  };
}

// ── Export / Import ──

/**
 * Export the compiled DNA to file and DB config.
 */
export async function exportDNA(dna: PersonalityDNA): Promise<string> {
  // DB is the source of truth (wiki pattern). The file is a portable copy -- the
  // point of DNA is to be shareable / cold-start another instance.
  try {
    await upsertPersonalityDocument(resolveMemoryUserId(undefined), "dna", dna);
  } catch {
    // DB may be unavailable; the portable file below still works.
  }

  const filePath = getDnaPath();
  await mkdir(join(homedir(), ".nomos"), { recursive: true });
  await writeFile(filePath, JSON.stringify(dna, null, 2), "utf-8");
  return filePath;
}

/**
 * Import DNA from a file and inflate into user model entries.
 */
export async function importDNA(
  filePath?: string,
): Promise<{ patterns: number; values: number; exemplars: number }> {
  const path = filePath ?? getDnaPath();
  const content = await readFile(path, "utf-8");
  const dna = JSON.parse(content) as PersonalityDNA;

  const result = { patterns: 0, values: 0, exemplars: 0 };

  // Inflate decision patterns
  for (const pattern of dna.decisionPatterns) {
    const key = pattern.principle
      .slice(0, 60)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    await upsertUserModel({
      userId: resolveMemoryUserId(undefined),
      category: "decision_pattern",
      key,
      value: {
        principle: pattern.principle,
        context: pattern.context,
        weight: pattern.weight,
        evidence: ["Imported from Personality DNA"],
        exceptions: pattern.exceptions,
      },
      sourceIds: [],
      confidence: 0.7, // Imported -- plausible but unverified
    });
    result.patterns++;
  }

  // Inflate values
  for (const value of dna.values) {
    const key = value.value
      .slice(0, 60)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    await upsertUserModel({
      userId: resolveMemoryUserId(undefined),
      category: "value",
      key,
      value: {
        value: value.value,
        description: value.description,
      },
      sourceIds: [],
      confidence: 0.7,
    });
    result.values++;
  }

  // Store exemplar fingerprints
  for (const exemplar of dna.exemplarFingerprints) {
    const key = `exemplar_${exemplar.text
      .slice(0, 30)
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()}`;
    await upsertUserModel({
      userId: resolveMemoryUserId(undefined),
      category: "exemplar",
      key,
      value: {
        text: exemplar.text,
        context: exemplar.context,
      },
      sourceIds: [],
      confidence: 0.7,
    });
    result.exemplars++;
  }

  return result;
}

/**
 * Load the last exported DNA from file.
 */
export async function loadExportedDNA(): Promise<PersonalityDNA | null> {
  // DB first (source of truth), then the portable file as a fallback.
  try {
    const fromDb = await getPersonalityDocument<PersonalityDNA>(
      resolveMemoryUserId(undefined),
      "dna",
    );
    if (fromDb) return fromDb;
  } catch {
    // fall through to the file
  }
  try {
    return JSON.parse(await readFile(getDnaPath(), "utf-8")) as PersonalityDNA;
  } catch {
    return null;
  }
}

// ── Helpers ──

function extractStyleGenome(preferences: UserModelEntry[]): DNAStyleGenome {
  const genome: DNAStyleGenome = {
    formality: 3,
    tone: "neutral",
    avgLength: "moderate",
    emojiUsage: "rare",
    vocabularyMarkers: [],
    punctuationStyle: "standard",
    signaturePhrases: [],
  };

  for (const pref of preferences) {
    const key = pref.key.toLowerCase();
    const val = typeof pref.value === "string" ? pref.value : JSON.stringify(pref.value);

    if (key.includes("formality")) {
      const num = parseFloat(val);
      if (!isNaN(num)) genome.formality = num;
    }
    if (key.includes("tone")) genome.tone = val;
    if (key.includes("emoji")) genome.emojiUsage = val;
    if (key.includes("length") || key.includes("verbose")) genome.avgLength = val;
    if (key.includes("punctuation")) genome.punctuationStyle = val;
  }

  return genome;
}

function extractBehavioralSignatures(
  patterns: UserModelEntry[],
  preferences: UserModelEntry[],
): Record<string, string> {
  const sigs: Record<string, string> = {};

  for (const pref of preferences) {
    const key = pref.key.toLowerCase();
    const val = typeof pref.value === "string" ? pref.value : String(pref.value);

    if (key.includes("response") && key.includes("speed")) sigs.responseSpeed = val;
    if (key.includes("detail")) sigs.detailPreference = val;
    if (key.includes("question")) sigs.questionStyle = val;
  }

  // Infer from decision patterns
  for (const p of patterns) {
    const v = p.value as { context?: string; principle?: string };
    if (v.context?.includes("conflict")) {
      sigs.conflictApproach = v.principle?.slice(0, 50) ?? "unknown";
    }
  }

  return sigs;
}

function extractIdentitySummary(facts: UserModelEntry[]): PersonalityDNA["identity"] {
  const roles: string[] = [];
  const expertise: string[] = [];
  let summary = "A person whose personality has been captured through interaction.";

  for (const fact of facts) {
    const key = fact.key.toLowerCase();
    const val = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);

    if (key.includes("role") || key.includes("job") || key.includes("title")) {
      roles.push(val);
    }
    if (
      key.includes("expert") ||
      key.includes("skill") ||
      key.includes("language") ||
      key.includes("tech")
    ) {
      expertise.push(val);
    }
  }

  // Build summary from available data
  if (roles.length > 0 || expertise.length > 0) {
    const parts: string[] = [];
    if (roles.length > 0) parts.push(`Roles: ${roles.join(", ")}`);
    if (expertise.length > 0) parts.push(`Expertise: ${expertise.join(", ")}`);
    summary = parts.join(". ");
  }

  return {
    summary,
    roles: roles.slice(0, 5),
    expertise: expertise.slice(0, 10),
  };
}

/**
 * Format a compilation result for display.
 */
export function formatDNAPreview(result: CompilationResult): string {
  const { dna, stats } = result;
  const lines: string[] = [
    "Personality DNA Preview",
    "=======================",
    "",
    `Identity: ${dna.identity.summary}`,
    "",
    `Decision patterns: ${stats.includedPatterns}/${stats.totalPatterns}`,
  ];

  for (const p of dna.decisionPatterns.slice(0, 3)) {
    lines.push(`  - ${p.principle} (weight: ${p.weight})`);
  }
  if (dna.decisionPatterns.length > 3) {
    lines.push(`  ... and ${dna.decisionPatterns.length - 3} more`);
  }

  lines.push("", `Values: ${stats.includedValues}/${stats.totalValues}`);
  for (const v of dna.values) {
    lines.push(`  ${v.rank}. ${v.value}: ${v.description}`);
  }

  lines.push("", `Style: ${dna.styleGenome.tone}, formality ${dna.styleGenome.formality}/5`);
  lines.push(`Exemplar fingerprints: ${stats.includedExemplars}/${stats.totalExemplars}`);
  lines.push("", `Estimated size: ~${stats.estimatedTokens} tokens`);

  return lines.join("\n");
}
