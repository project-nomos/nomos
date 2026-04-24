/**
 * Query complexity classifier for smart model routing.
 *
 * Classifies incoming messages into complexity tiers using weighted
 * keyword scoring across 7 dimensions. Routes simple queries to
 * fast/cheap models and complex queries to powerful models.
 *
 * Runs in sub-millisecond time with zero LLM calls.
 *
 * Inspired by warengonzaga/tinyclaw's 8-dimension classifier.
 */

export type ComplexityTier = "simple" | "moderate" | "complex";

export interface ClassificationResult {
  tier: ComplexityTier;
  confidence: number;
  scores: Record<string, number>;
}

interface Dimension {
  name: string;
  weight: number;
  keywords: string[];
}

const DIMENSIONS: Dimension[] = [
  {
    name: "reasoning",
    weight: 0.22,
    keywords: [
      "analyze",
      "explain",
      "prove",
      "compare",
      "evaluate",
      "assess",
      "trade-off",
      "tradeoff",
      "pros and cons",
      "reasoning",
      "logic",
      "implications",
      "consequences",
      "hypothesis",
      "theory",
      "argument",
      "critique",
      "justify",
      "chain of thought",
      "step by step",
      "think through",
      "consider",
      "weigh",
    ],
  },
  {
    name: "code",
    weight: 0.2,
    keywords: [
      "function",
      "class",
      "import",
      "export",
      "async",
      "await",
      "const",
      "interface",
      "type",
      "debug",
      "refactor",
      "implement",
      "algorithm",
      "data structure",
      "api",
      "endpoint",
      "database",
      "query",
      "migration",
      "test",
      "bug",
      "error",
      "fix",
      "optimize",
      "performance",
      "regex",
      "parse",
      "compile",
      "deploy",
      "docker",
      "kubernetes",
      "infrastructure",
      "```",
    ],
  },
  {
    name: "multi_step",
    weight: 0.15,
    keywords: [
      "first",
      "then",
      "next",
      "after that",
      "finally",
      "step 1",
      "step 2",
      "step 3",
      "plan",
      "strategy",
      "roadmap",
      "pipeline",
      "workflow",
      "process",
      "sequence",
      "stages",
      "phases",
      "multiple",
      "several",
      "each",
      "all of",
      "list of",
    ],
  },
  {
    name: "technical",
    weight: 0.13,
    keywords: [
      "architecture",
      "system design",
      "distributed",
      "scalability",
      "concurrency",
      "latency",
      "throughput",
      "caching",
      "replication",
      "sharding",
      "consensus",
      "encryption",
      "authentication",
      "authorization",
      "protocol",
      "specification",
      "standard",
      "compliance",
      "security",
      "vulnerability",
    ],
  },
  {
    name: "creative",
    weight: 0.15,
    keywords: [
      "write",
      "story",
      "poem",
      "brainstorm",
      "ideate",
      "creative",
      "generate",
      "compose",
      "draft",
      "design",
      "name",
      "suggest",
      "imagine",
      "invent",
      "original",
    ],
  },
  {
    name: "constraints",
    weight: 0.08,
    keywords: [
      "constraint",
      "requirement",
      "must",
      "should",
      "shall",
      "ensure",
      "guarantee",
      "validate",
      "verify",
      "strict",
      "exact",
      "precise",
      "format",
      "standard",
      "compatible",
      "backward",
      "specification",
    ],
  },
  {
    name: "simple",
    weight: -0.14,
    keywords: [
      "hello",
      "hi",
      "hey",
      "thanks",
      "thank you",
      "ok",
      "okay",
      "yes",
      "no",
      "sure",
      "great",
      "cool",
      "nice",
      "got it",
      "sounds good",
      "bye",
      "goodbye",
      "what time",
      "what day",
      "who are you",
      "what is your name",
      "how are you",
    ],
  },
];

/**
 * Estimate token count from text (rough approximation: ~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sigmoid function for smooth confidence scoring.
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Classify a query's complexity to determine which model tier to use.
 *
 * Returns a tier ("simple", "moderate", "complex") with a confidence score.
 * Sub-millisecond execution, no external calls.
 */
export function classifyQuery(text: string): ClassificationResult {
  const lower = text.toLowerCase();
  const tokens = estimateTokens(text);

  // Score each dimension
  const scores: Record<string, number> = {};
  let totalScore = 0;

  for (const dim of DIMENSIONS) {
    let hits = 0;
    for (const keyword of dim.keywords) {
      if (lower.includes(keyword)) {
        hits++;
      }
    }
    // Normalize by keyword count to prevent dimensions with more keywords from dominating
    const rawScore = hits / dim.keywords.length;
    const weightedScore = rawScore * dim.weight;
    scores[dim.name] = rawScore;
    totalScore += weightedScore;
  }

  // Add prompt length factor (longer prompts tend to be more complex)
  const lengthScore = Math.min(tokens / 500, 1) * 0.14;
  scores["length"] = Math.min(tokens / 500, 1);
  totalScore += lengthScore;

  // Code block detection bonus (scaled by count)
  const codeBlocks = (text.match(/```/g) ?? []).length / 2;
  if (codeBlocks > 0) {
    totalScore += Math.min(codeBlocks * 0.02, 0.06);
    scores["code_blocks"] = codeBlocks;
  }

  // Force complex tier for known multi-step skills
  const COMPLEX_SKILLS = ["/twin-test", "/calibrate", "/reflect", "/dna", "/team"];
  const forceComplex = COMPLEX_SKILLS.some((s) => lower.includes(s));
  if (forceComplex) {
    totalScore = Math.max(totalScore, 0.1);
  }

  // Force at least moderate for any skill invocation
  if (lower.includes("/") && /\/[a-z]/.test(lower)) {
    totalScore = Math.max(totalScore, 0.03);
  }

  // Determine tier from total score using sigmoid for smooth boundaries
  const confidence = sigmoid(totalScore * 10 - 2);

  let tier: ComplexityTier;
  if (totalScore < 0.02) {
    tier = "simple";
  } else if (totalScore < 0.08) {
    tier = "moderate";
  } else {
    tier = "complex";
  }

  return { tier, confidence, scores };
}
