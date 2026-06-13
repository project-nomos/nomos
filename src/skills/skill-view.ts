/**
 * Consumer Skills view model -- the pure shaping behind MobileApi.ListSkills.
 *
 * loadSkills() returns the full power-user catalog: bundled dev/internal skills
 * (run-evals, self-improve, skill-creator, ...), channel adapters, AND the
 * operator-curated external skills (NOMOS_SKILLS_DIR). A consumer should only
 * see the genuinely user-facing ones, under friendly labels. Pure +
 * dependency-free so it is unit-testable in isolation.
 */

import type { Skill } from "./types.ts";

export interface ConsumerSkill {
  /** Friendly label. Also the toggle round-trip key (resolved back server-side). */
  name: string;
  description: string;
  /** Display badge: google | built-in | add-on. */
  source: string;
  enabled: boolean;
  certs: string[];
  price: string;
}

/** Bundled skills appropriate for a consumer. Everything else bundled is
 * dev/internal/channel tooling and is hidden. Operator-curated external skills
 * (source="external") are always surfaced. */
export const CONSUMER_BUNDLED_SKILLS = new Set([
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "weather",
  "doc-coauthoring",
  "internal-comms",
]);

/** raw skill name -> friendly label. Covers every surfaced skill so both the
 * display and the toggle round-trip are deterministic. */
export const SKILL_LABELS: Record<string, string> = {
  // Operator-curated Google Workspace skills (external).
  "gmail-inbox-triage": "Inbox triage",
  "google-gmail": "Gmail",
  "google-calendar": "Calendar",
  "google-calendar-daily-brief": "Daily calendar brief",
  "google-calendar-free-up-time": "Free up time",
  "google-calendar-group-scheduler": "Group scheduler",
  "google-calendar-meeting-prep": "Meeting prep",
  "google-drive": "Drive",
  // Consumer bundled skills.
  pdf: "PDF tools",
  docx: "Word documents",
  pptx: "Presentations",
  xlsx: "Spreadsheets",
  weather: "Weather",
  "doc-coauthoring": "Document co-authoring",
  "internal-comms": "Writing assistant",
};

function titleCase(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function friendlySkillName(name: string): string {
  return SKILL_LABELS[name] ?? titleCase(name);
}

function skillBadge(s: Skill): string {
  if (/gmail|google|calendar|drive|gws/i.test(s.name)) return "google";
  return s.source === "external" ? "add-on" : "built-in";
}

function consumerDescription(s: Skill): string {
  // Sanitize author-written copy for the consumer UI (em dashes -> hyphens).
  const d = (s.description ?? "").replace(/\s*—\s*/g, " - ").trim();
  return d.length > 88 ? `${d.slice(0, 85).trimEnd()}...` : d;
}

export function isConsumerSkill(s: Skill): boolean {
  return s.source === "external" || CONSUMER_BUNDLED_SKILLS.has(s.name);
}

/**
 * Curate the consumer Skills list: filter to consumer-facing skills, friendly
 * labels + badges, with the user's enable/disable state folded in.
 * `enabledOf(name)` resolves the persisted toggle (default true).
 */
export function curateConsumerSkills(
  skills: Skill[],
  enabledOf: (name: string) => boolean,
): ConsumerSkill[] {
  return skills
    .filter(isConsumerSkill)
    .map((s) => ({
      name: friendlySkillName(s.name),
      description: consumerDescription(s),
      source: skillBadge(s),
      enabled: enabledOf(s.name),
      certs: [] as string[],
      price: "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a friendly label back to the raw skill name for the toggle round-trip.
 * Falls back to the label itself (already a raw name) when no match. */
export function resolveSkillName(skills: Skill[], label: string): string {
  return skills.find((s) => friendlySkillName(s.name) === label)?.name ?? label;
}
