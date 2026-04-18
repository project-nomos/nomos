/**
 * Theory of Mind Engine -- real-time, per-session model of the user's mental state.
 *
 * Lightweight rule-based classifier (no LLM call) that updates after each turn.
 * Signals: message length, explicit emotion, time between messages, session
 * duration, time of day, upcoming commitments.
 *
 * The state is transient (session-scoped, never persisted) and injected into
 * the system prompt as a "Current User State" section so the agent can adapt
 * its response style.
 */

// ── Types ──

export type FocusLevel = "deep" | "normal" | "scattered";
export type EmotionSignal = "neutral" | "positive" | "frustrated" | "stressed" | "excited";
export type CognitiveLoad = "low" | "moderate" | "high";
export type UrgencyLevel = "none" | "mild" | "high" | "critical";
export type EnergyLevel = "high" | "normal" | "low";

export interface UserMentalState {
  focus: FocusLevel;
  emotion: EmotionSignal;
  cognitiveLoad: CognitiveLoad;
  urgency: UrgencyLevel;
  energy: EnergyLevel;
  /** Whether the user seems stuck or blocked. */
  seemsStuck: boolean;
  /** Brief explanation of the state assessment. */
  summary: string;
  /** Suggested response style adaptation. */
  responseGuidance: string;
}

interface TurnSignals {
  messageLength: number;
  wordCount: number;
  hasQuestion: boolean;
  hasExplicitEmotion: boolean;
  emotionPolarity: "positive" | "negative" | "neutral";
  hasUrgencyMarkers: boolean;
  hasCodeBlock: boolean;
  isCorrection: boolean;
  isShortReply: boolean;
  isLongExploration: boolean;
}

// ── Session Tracker ──

export class TheoryOfMindTracker {
  private turnTimestamps: number[] = [];
  private turnSignals: TurnSignals[] = [];
  private sessionStartedAt: number;
  private consecutiveShortReplies = 0;
  private consecutiveQuestions = 0;
  private correctionCount = 0;

  constructor() {
    this.sessionStartedAt = Date.now();
  }

  /**
   * Update the state model with a new user message.
   * Call this after each user turn, before generating a response.
   */
  update(userMessage: string): UserMentalState {
    const now = Date.now();
    this.turnTimestamps.push(now);

    const signals = this.analyzeMessage(userMessage);
    this.turnSignals.push(signals);

    // Track consecutive patterns
    if (signals.isShortReply) {
      this.consecutiveShortReplies++;
    } else {
      this.consecutiveShortReplies = 0;
    }

    if (signals.hasQuestion) {
      this.consecutiveQuestions++;
    } else {
      this.consecutiveQuestions = 0;
    }

    if (signals.isCorrection) {
      this.correctionCount++;
    }

    return this.computeState();
  }

  /**
   * Get the current state without updating (for mid-turn reads).
   */
  getCurrentState(): UserMentalState {
    return this.computeState();
  }

  /**
   * Format the state as a system prompt section.
   * Returns empty string if no turns have been processed.
   */
  formatForPrompt(): string {
    if (this.turnSignals.length === 0) return "";

    const state = this.computeState();
    const lines = [
      `## Current User State`,
      `Focus: ${state.focus} | Emotion: ${state.emotion} | Cognitive load: ${state.cognitiveLoad} | Urgency: ${state.urgency} | Energy: ${state.energy}`,
      `Assessment: ${state.summary}`,
      "",
      `**Response guidance:** ${state.responseGuidance}`,
    ];

    return lines.join("\n");
  }

  // ── Private ──

  private analyzeMessage(msg: string): TurnSignals {
    const lower = msg.toLowerCase();
    const words = msg.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    return {
      messageLength: msg.length,
      wordCount,
      hasQuestion: /\?/.test(msg),
      hasExplicitEmotion: EMOTION_PATTERNS.some((p) => p.pattern.test(lower)),
      emotionPolarity: this.detectEmotionPolarity(lower),
      hasUrgencyMarkers: URGENCY_PATTERNS.some((p) => p.test(lower)),
      hasCodeBlock: /```/.test(msg),
      isCorrection: CORRECTION_PATTERNS.some((p) => p.test(lower)),
      isShortReply: wordCount <= 5 && !msg.includes("```"),
      isLongExploration: wordCount > 100 && /\?/.test(msg),
    };
  }

  private detectEmotionPolarity(lower: string): "positive" | "negative" | "neutral" {
    const posMatch = POSITIVE_EMOTIONS.some((p) => p.test(lower));
    const negMatch = NEGATIVE_EMOTIONS.some((p) => p.test(lower));
    if (posMatch && !negMatch) return "positive";
    if (negMatch && !posMatch) return "negative";
    return "neutral";
  }

  private computeState(): UserMentalState {
    const recent = this.turnSignals.slice(-5); // Last 5 turns
    if (recent.length === 0) {
      return defaultState();
    }

    const focus = this.assessFocus(recent);
    const emotion = this.assessEmotion(recent);
    const cognitiveLoad = this.assessCognitiveLoad(recent);
    const urgency = this.assessUrgency(recent);
    const energy = this.assessEnergy();
    const seemsStuck = this.assessStuck(recent);

    const summary = this.buildSummary(focus, emotion, cognitiveLoad, urgency, seemsStuck);
    const responseGuidance = this.buildGuidance(
      focus,
      emotion,
      cognitiveLoad,
      urgency,
      energy,
      seemsStuck,
    );

    return {
      focus,
      emotion,
      cognitiveLoad,
      urgency,
      energy,
      seemsStuck,
      summary,
      responseGuidance,
    };
  }

  private assessFocus(recent: TurnSignals[]): FocusLevel {
    const avgWords = recent.reduce((s, t) => s + t.wordCount, 0) / recent.length;
    const hasCode = recent.some((t) => t.hasCodeBlock);
    const longExploring = recent.some((t) => t.isLongExploration);

    if (hasCode || longExploring || avgWords > 50) return "deep";
    if (this.consecutiveShortReplies >= 3) return "scattered";
    return "normal";
  }

  private assessEmotion(recent: TurnSignals[]): EmotionSignal {
    const lastTurn = recent[recent.length - 1];
    if (!lastTurn.hasExplicitEmotion) {
      // Infer from patterns
      if (this.correctionCount >= 3 && recent.length <= 8) return "frustrated";
      if (this.consecutiveShortReplies >= 4) return "stressed";
      return "neutral";
    }

    if (lastTurn.emotionPolarity === "positive") {
      return recent.some((t) => t.hasUrgencyMarkers) ? "excited" : "positive";
    }
    if (lastTurn.emotionPolarity === "negative") {
      return this.correctionCount >= 2 ? "frustrated" : "stressed";
    }
    return "neutral";
  }

  private assessCognitiveLoad(recent: TurnSignals[]): CognitiveLoad {
    const avgWords = recent.reduce((s, t) => s + t.wordCount, 0) / recent.length;
    const questionRate = recent.filter((t) => t.hasQuestion).length / recent.length;

    if (avgWords > 80 || (questionRate > 0.6 && recent.length >= 3)) return "high";
    if (avgWords < 15 && questionRate < 0.2) return "low";
    return "moderate";
  }

  private assessUrgency(recent: TurnSignals[]): UrgencyLevel {
    const urgentCount = recent.filter((t) => t.hasUrgencyMarkers).length;
    const lastIsUrgent = recent[recent.length - 1]?.hasUrgencyMarkers;

    if (urgentCount >= 3 || (lastIsUrgent && urgentCount >= 2)) return "critical";
    if (lastIsUrgent) return "high";
    if (urgentCount >= 1) return "mild";
    return "none";
  }

  private assessEnergy(): EnergyLevel {
    const hour = new Date().getHours();
    const sessionMinutes = (Date.now() - this.sessionStartedAt) / 60000;

    // Late night or very long session suggests lower energy
    if ((hour >= 23 || hour < 6) && sessionMinutes > 30) return "low";
    if (sessionMinutes > 120) return "low"; // 2+ hour session
    if (hour >= 9 && hour <= 11) return "high"; // Morning peak
    return "normal";
  }

  private assessStuck(recent: TurnSignals[]): boolean {
    // Stuck signals: many questions in a row, corrections, or repeating short messages
    if (this.consecutiveQuestions >= 3) return true;
    if (this.consecutiveShortReplies >= 4 && recent.some((t) => t.hasQuestion)) return true;
    // Multiple corrections suggest the user isn't getting what they need
    if (this.correctionCount >= 3 && recent.length <= 6) return true;
    return false;
  }

  private buildSummary(
    focus: FocusLevel,
    emotion: EmotionSignal,
    load: CognitiveLoad,
    urgency: UrgencyLevel,
    stuck: boolean,
  ): string {
    const parts: string[] = [];

    if (stuck) parts.push("User appears to be stuck or blocked");
    if (urgency === "critical") parts.push("High urgency detected");
    if (emotion === "frustrated") parts.push("Showing signs of frustration");
    if (emotion === "stressed") parts.push("May be under time pressure");
    if (focus === "deep") parts.push("In deep focus mode");
    if (focus === "scattered") parts.push("Attention seems scattered");
    if (load === "high") parts.push("Dealing with complex topic");

    if (parts.length === 0) {
      if (emotion === "positive") return "User is engaged and in a good mood";
      return "Normal engagement, no special signals detected";
    }

    return parts.join(". ");
  }

  private buildGuidance(
    focus: FocusLevel,
    emotion: EmotionSignal,
    load: CognitiveLoad,
    urgency: UrgencyLevel,
    energy: EnergyLevel,
    stuck: boolean,
  ): string {
    const hints: string[] = [];

    if (stuck) {
      hints.push("Ask a clarifying question or offer a different approach");
    }
    if (urgency === "critical" || urgency === "high") {
      hints.push("Be concise and action-oriented -- skip context, give the answer");
    }
    if (emotion === "frustrated") {
      hints.push("Acknowledge the difficulty, be direct and helpful, avoid over-explaining");
    }
    if (emotion === "stressed") {
      hints.push("Keep responses brief, focus on the immediate need");
    }
    if (focus === "deep" && load === "high") {
      hints.push("Match the user's depth -- provide thorough, detailed responses");
    }
    if (focus === "scattered") {
      hints.push("Help the user focus -- summarize, suggest next step");
    }
    if (energy === "low") {
      hints.push("Keep it brief -- the user may be tired");
    }
    if (emotion === "positive" || emotion === "excited") {
      hints.push("Match the user's energy -- be enthusiastic");
    }

    if (hints.length === 0)
      return "Normal response style -- match the user's tone and detail level";
    return hints.join(". ");
  }
}

// ── Singleton per-process (reset on new session) ──

let activeTracker: TheoryOfMindTracker | null = null;

export function getTheoryOfMindTracker(): TheoryOfMindTracker {
  if (!activeTracker) {
    activeTracker = new TheoryOfMindTracker();
  }
  return activeTracker;
}

export function resetTheoryOfMindTracker(): void {
  activeTracker = new TheoryOfMindTracker();
}

// ── Pattern Libraries ──

function defaultState(): UserMentalState {
  return {
    focus: "normal",
    emotion: "neutral",
    cognitiveLoad: "moderate",
    urgency: "none",
    energy: "normal",
    seemsStuck: false,
    summary: "Session starting -- no signals yet",
    responseGuidance: "Normal response style -- match the user's tone and detail level",
  };
}

const EMOTION_PATTERNS = [
  {
    pattern: /\b(love|great|awesome|perfect|amazing|nice|wonderful|fantastic)\b/,
    polarity: "positive" as const,
  },
  { pattern: /\b(thanks|thank you|thx|ty|cheers)\b/, polarity: "positive" as const },
  {
    pattern: /\b(frustrated|annoying|annoyed|ugh|damn|wtf|broken|hate)\b/,
    polarity: "negative" as const,
  },
  {
    pattern: /\b(confused|lost|stuck|help|unclear|don't understand)\b/,
    polarity: "negative" as const,
  },
  { pattern: /[!]{2,}/, polarity: "positive" as const },
];

const POSITIVE_EMOTIONS = EMOTION_PATTERNS.filter((p) => p.polarity === "positive").map(
  (p) => p.pattern,
);
const NEGATIVE_EMOTIONS = EMOTION_PATTERNS.filter((p) => p.polarity === "negative").map(
  (p) => p.pattern,
);

const URGENCY_PATTERNS = [
  /\b(asap|urgent|hurry|quickly|rush|deadline|critical|blocking|blocker)\b/,
  /\b(right now|immediately|as soon as possible|time.?sensitive)\b/,
  /\b(production.?down|outage|incident|p[01]\b)/,
];

const CORRECTION_PATTERNS = [
  /\b(no[,.]?\s+(that's|thats|not)\s+(not|right|wrong|what))/,
  /\b(wrong|incorrect|that's not|not what i|i said|i meant|actually)\b/,
  /\b(don't|do not|stop|please don't)\b.*\b(do|use|add|make|include)\b/,
];
