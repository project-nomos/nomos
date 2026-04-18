/**
 * Calibration analysis -- identifies gaps in the user model
 * and generates targeted scenario prompts for the Socratic Coach skill.
 *
 * Uses gap analysis over user_model categories to find under-modeled areas,
 * then selects scenarios from the library that would fill those gaps.
 */

import { getUserModel, type UserModelEntry } from "../db/user-model.ts";

/** Domains that the calibration system covers. */
export const CALIBRATION_DOMAINS = [
  "tech_decisions",
  "communication",
  "conflict",
  "prioritization",
  "leadership",
  "quality",
  "collaboration",
  "risk",
  "creativity",
  "time_management",
] as const;

export type CalibrationDomain = (typeof CALIBRATION_DOMAINS)[number];

export interface CalibrationGap {
  domain: CalibrationDomain;
  coverage: number; // 0-1, how well this domain is modeled
  reason: string;
}

export interface CalibrationScenario {
  domain: CalibrationDomain;
  id: string;
  prompt: string;
  followUps: string[];
  /** What this scenario probes for (shown in gap analysis, not to user). */
  probes: string;
}

export interface CalibrationStatus {
  totalEntries: number;
  decisionPatterns: number;
  values: number;
  preferences: number;
  facts: number;
  overallCoverage: number; // 0-1
  gaps: CalibrationGap[];
  nextDomain: CalibrationDomain | null;
}

/**
 * Scenario library organized by domain.
 * Each scenario presents a realistic dilemma that reveals decision heuristics and values.
 */
const SCENARIO_LIBRARY: CalibrationScenario[] = [
  // Tech Decisions
  {
    domain: "tech_decisions",
    id: "td_framework_choice",
    prompt:
      "You're starting a new project and need to choose between a well-known framework you're comfortable with versus a newer one that's better suited to the problem but has a steeper learning curve. The deadline is 6 weeks out. What do you do, and why?",
    followUps: [
      "What if the deadline was 2 weeks instead?",
      "What if this was for a side project with no deadline?",
      "How do you generally weigh 'proven and comfortable' vs 'technically optimal'?",
    ],
    probes: "risk tolerance, pragmatism vs perfectionism, time pressure response",
  },
  {
    domain: "tech_decisions",
    id: "td_refactor_vs_ship",
    prompt:
      "You've inherited a codebase with significant tech debt. You could ship the requested feature on top of the existing mess in 3 days, or refactor first and ship in 2 weeks. Your manager wants the feature this week. What's your move?",
    followUps: [
      "At what point does tech debt become a dealbreaker for you?",
      "How do you communicate the trade-off to non-technical stakeholders?",
    ],
    probes: "pragmatism, stakeholder communication, quality thresholds",
  },
  {
    domain: "tech_decisions",
    id: "td_build_vs_buy",
    prompt:
      "Your team needs a notification system. You could use a third-party service ($200/mo) or build a basic one in-house (2-3 weeks). The third-party has features you don't need yet but might later. What's your instinct?",
    followUps: [
      "How do you generally think about build vs buy decisions?",
      "What factors would flip your decision?",
    ],
    probes: "build vs buy heuristic, cost sensitivity, long-term thinking",
  },

  // Communication
  {
    domain: "communication",
    id: "comm_bad_news",
    prompt:
      "You need to tell a colleague that their approach to a shared project won't work and you'll need to redo significant parts. They've invested two weeks in it. How do you handle this conversation?",
    followUps: [
      "Do you prefer to deliver difficult feedback in writing or face-to-face?",
      "How direct are you generally -- do you soften bad news or get straight to the point?",
    ],
    probes: "directness, empathy, feedback style",
  },
  {
    domain: "communication",
    id: "comm_async_sync",
    prompt:
      "A teammate wants to schedule a 30-minute meeting to discuss something. You think it could be handled in a Slack thread. How do you respond?",
    followUps: [
      "When do you think meetings ARE the right choice?",
      "How do you balance efficiency with relationship-building in communication?",
    ],
    probes: "async preference, meeting tolerance, communication efficiency",
  },

  // Conflict
  {
    domain: "conflict",
    id: "conf_design_disagreement",
    prompt:
      "You and a respected peer strongly disagree on a technical design. You've both made your cases and neither is budging. The rest of the team is split. How do you resolve this?",
    followUps: [
      "Do you tend to compromise, defer, or push for your position?",
      "How do you handle it when you turn out to be wrong after a disagreement?",
    ],
    probes: "conflict resolution style, ego management, consensus building",
  },

  // Prioritization
  {
    domain: "prioritization",
    id: "pri_competing_urgent",
    prompt:
      "It's Monday morning. You have: a production bug affecting 5% of users, a feature demo for a potential big client on Wednesday, and a team member asking for help with something they're stuck on. How do you prioritize your day?",
    followUps: [
      "What's your general framework for deciding what's most important?",
      "How do you handle the feeling of things falling through the cracks?",
    ],
    probes: "urgency vs importance, stakeholder weighing, triage instinct",
  },
  {
    domain: "prioritization",
    id: "pri_scope_creep",
    prompt:
      "You're 60% through a project and the stakeholder asks for 'one more thing' that would add a week. You're already slightly behind. What do you say?",
    followUps: [
      "How do you generally handle scope creep?",
      "What's your relationship with saying 'no' to requests?",
    ],
    probes: "boundary setting, scope management, people-pleasing tendency",
  },

  // Leadership
  {
    domain: "leadership",
    id: "lead_delegation",
    prompt:
      "You have a critical task that you could do in 2 hours, or delegate to a junior who'd take 6 hours but would learn a lot. Deadline is tomorrow. What do you do?",
    followUps: [
      "How do you decide what to delegate vs do yourself?",
      "What's more important to you: team growth or delivery speed?",
    ],
    probes: "delegation comfort, mentorship value, control tendencies",
  },

  // Quality
  {
    domain: "quality",
    id: "qual_good_enough",
    prompt:
      "You've built something that works but the code isn't as clean as you'd like. Tests pass, users are happy. Do you ship it or spend another day polishing?",
    followUps: [
      "Where do you draw the line between 'good enough' and 'done right'?",
      "Does your answer change for different types of projects (startup vs enterprise)?",
    ],
    probes: "perfectionism, pragmatic quality bar, context-dependent standards",
  },

  // Collaboration
  {
    domain: "collaboration",
    id: "collab_solo_vs_pair",
    prompt:
      "You're working on a complex problem. A teammate offers to pair program on it. You think you could solve it faster alone but they have relevant domain knowledge. What do you prefer?",
    followUps: [
      "How do you generally feel about pair programming?",
      "When do you prefer working alone vs collaborating?",
    ],
    probes: "collaboration preference, autonomy needs, knowledge sharing attitude",
  },

  // Risk
  {
    domain: "risk",
    id: "risk_deploy_friday",
    prompt:
      "It's Friday afternoon. You've just finished a feature that passed all tests. Do you deploy now or wait until Monday?",
    followUps: [
      "What's your general approach to risk in deployments?",
      "How do you think about the cost of waiting vs the cost of a potential issue?",
    ],
    probes: "risk tolerance, deployment philosophy, prudence vs speed",
  },

  // Creativity
  {
    domain: "creativity",
    id: "cre_unconventional",
    prompt:
      "You have an unconventional solution to a problem. It's elegant and efficient but uses a pattern nobody on the team has seen before. Do you propose it or go with the standard approach?",
    followUps: [
      "How do you balance innovation with team maintainability?",
      "What makes you most excited about your work?",
    ],
    probes: "innovation appetite, team-awareness, novelty preference",
  },

  // Time Management
  {
    domain: "time_management",
    id: "tm_deep_work",
    prompt:
      "You have a complex problem that needs deep focus, but you also have 4 Slack messages, 2 email threads, and a PR review pending. How do you structure your time?",
    followUps: [
      "How do you protect your focus time?",
      "What's your relationship with notifications and responsiveness expectations?",
    ],
    probes: "focus management, responsiveness, context-switching tolerance",
  },
];

/**
 * Analyze the user model and identify calibration gaps.
 */
export async function analyzeCalibrationGaps(): Promise<CalibrationStatus> {
  let entries: UserModelEntry[];
  try {
    entries = await getUserModel();
  } catch {
    entries = [];
  }

  const decisionPatterns = entries.filter((e) => e.category === "decision_pattern");
  const values = entries.filter((e) => e.category === "value");
  const preferences = entries.filter((e) => e.category === "preference");
  const facts = entries.filter((e) => e.category === "fact");

  // Analyze domain coverage by checking which domains have decision patterns or values
  const coveredDomains = new Set<string>();
  for (const entry of [...decisionPatterns, ...values]) {
    const val = entry.value as Record<string, unknown>;
    const context = (val.context as string) ?? "";
    // Map contexts to domains
    for (const domain of CALIBRATION_DOMAINS) {
      if (contextMatchesDomain(context, domain) || keyMatchesDomain(entry.key, domain)) {
        coveredDomains.add(domain);
      }
    }
  }

  const gaps: CalibrationGap[] = [];
  for (const domain of CALIBRATION_DOMAINS) {
    const domainPatterns = decisionPatterns.filter(
      (e) =>
        contextMatchesDomain((e.value as Record<string, unknown>).context as string, domain) ||
        keyMatchesDomain(e.key, domain),
    );
    const domainValues = values.filter(
      (e) =>
        contextMatchesDomain((e.value as Record<string, unknown>).context as string, domain) ||
        keyMatchesDomain(e.key, domain),
    );

    const patternCoverage = Math.min(domainPatterns.length / 3, 1); // 3 patterns = fully covered
    const valueCoverage = Math.min(domainValues.length / 2, 1); // 2 values = fully covered
    const coverage = patternCoverage * 0.6 + valueCoverage * 0.4;

    if (coverage < 0.7) {
      gaps.push({
        domain,
        coverage: Math.round(coverage * 100) / 100,
        reason:
          coverage === 0
            ? `No data about your ${formatDomainName(domain)} approach`
            : `Limited data (${domainPatterns.length} patterns, ${domainValues.length} values)`,
      });
    }
  }

  // Sort gaps by coverage (least covered first)
  gaps.sort((a, b) => a.coverage - b.coverage);

  const overallCoverage =
    CALIBRATION_DOMAINS.length > 0
      ? 1 - gaps.reduce((sum, g) => sum + (1 - g.coverage), 0) / CALIBRATION_DOMAINS.length
      : 0;

  return {
    totalEntries: entries.length,
    decisionPatterns: decisionPatterns.length,
    values: values.length,
    preferences: preferences.length,
    facts: facts.length,
    overallCoverage: Math.round(overallCoverage * 100) / 100,
    gaps,
    nextDomain: gaps.length > 0 ? gaps[0].domain : null,
  };
}

/**
 * Get scenarios for a specific domain, or for the least-covered domain.
 */
export function getScenariosForDomain(domain?: CalibrationDomain): CalibrationScenario[] {
  if (domain) {
    return SCENARIO_LIBRARY.filter((s) => s.domain === domain);
  }
  return SCENARIO_LIBRARY;
}

/**
 * Get the next best scenario to run based on gap analysis.
 * Avoids scenarios whose domain is already well-covered.
 */
export async function getNextScenario(
  completedIds?: string[],
): Promise<CalibrationScenario | null> {
  const status = await analyzeCalibrationGaps();

  if (status.gaps.length === 0) return null;

  const completed = new Set(completedIds ?? []);

  // Try each gap domain in priority order
  for (const gap of status.gaps) {
    const scenarios = SCENARIO_LIBRARY.filter(
      (s) => s.domain === gap.domain && !completed.has(s.id),
    );
    if (scenarios.length > 0) return scenarios[0];
  }

  // All scenarios for gap domains completed -- try any uncompleted scenario
  const remaining = SCENARIO_LIBRARY.filter((s) => !completed.has(s.id));
  return remaining.length > 0 ? remaining[0] : null;
}

/**
 * Format the calibration status as a human-readable summary.
 */
export function formatCalibrationStatus(status: CalibrationStatus): string {
  const pct = Math.round(status.overallCoverage * 100);
  const bar = renderProgressBar(status.overallCoverage, 20);

  const lines = [
    `Clone calibration: ${pct}% ${bar}`,
    "",
    `Model: ${status.decisionPatterns} decision patterns, ${status.values} values, ${status.preferences} preferences, ${status.facts} facts`,
    "",
  ];

  if (status.gaps.length === 0) {
    lines.push("All domains well-covered. Run calibration again to deepen existing areas.");
  } else {
    lines.push(`Gaps (${status.gaps.length} domains need more data):`);
    for (const gap of status.gaps) {
      const domainPct = Math.round(gap.coverage * 100);
      lines.push(`  ${formatDomainName(gap.domain)}: ${domainPct}% -- ${gap.reason}`);
    }
  }

  return lines.join("\n");
}

// ── Helpers ──

function contextMatchesDomain(context: string | undefined, domain: CalibrationDomain): boolean {
  if (!context) return false;
  const ctx = context.toLowerCase();
  const keywords = DOMAIN_KEYWORDS[domain] ?? [];
  return keywords.some((kw) => ctx.includes(kw));
}

function keyMatchesDomain(key: string, domain: CalibrationDomain): boolean {
  const k = key.toLowerCase();
  const keywords = DOMAIN_KEYWORDS[domain] ?? [];
  return keywords.some((kw) => k.includes(kw));
}

const DOMAIN_KEYWORDS: Record<CalibrationDomain, string[]> = {
  tech_decisions: ["tech", "framework", "architecture", "stack", "tool", "library", "build", "buy"],
  communication: ["communicat", "message", "email", "slack", "meeting", "async", "feedback"],
  conflict: ["conflict", "disagree", "debate", "argument", "compromise", "pushback"],
  prioritization: ["priorit", "urgent", "important", "triage", "scope", "deadline", "backlog"],
  leadership: ["lead", "delegat", "mentor", "team", "manage", "hire"],
  quality: ["quality", "test", "clean", "polish", "refactor", "debt", "standard"],
  collaboration: ["collaborat", "pair", "review", "team", "share", "together"],
  risk: ["risk", "deploy", "rollback", "safety", "cautio", "bold"],
  creativity: ["creativ", "innovat", "unconventional", "novel", "experiment"],
  time_management: ["time", "focus", "deep work", "interrupt", "schedule", "productiv"],
};

function formatDomainName(domain: CalibrationDomain): string {
  return domain
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function renderProgressBar(fraction: number, width: number): string {
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${"-".repeat(empty)}]`;
}
