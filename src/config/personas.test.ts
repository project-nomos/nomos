import { describe, expect, it } from "vitest";
import {
  detectPersona,
  buildPersonaPrompt,
  type Persona,
  type MessageContext,
} from "./personas.ts";

const workPersona: Persona = {
  id: "work",
  name: "Work",
  description: "Professional context",
  triggers: {
    platforms: ["slack"],
    timeRanges: ["09:00-17:00"],
  },
  overrides: {
    tone: "professional",
    formality: 4,
    emojiUsage: "rare",
  },
  priority: 5,
  enabled: true,
};

const casualPersona: Persona = {
  id: "casual",
  name: "Casual",
  description: "Personal conversations",
  triggers: {
    platforms: ["imessage", "whatsapp"],
  },
  overrides: {
    tone: "warm",
    formality: 2,
    emojiUsage: "moderate",
  },
  priority: 3,
  enabled: true,
};

const techPersona: Persona = {
  id: "tech",
  name: "Technical",
  description: "Code discussions",
  triggers: {
    keywords: ["bug", "deploy", "PR"],
  },
  overrides: {
    tone: "direct",
    formality: 3,
    responseLength: "detailed",
  },
  priority: 7,
  enabled: true,
};

const disabledPersona: Persona = {
  id: "disabled",
  name: "Disabled",
  description: "Should not match",
  triggers: { platforms: ["slack"] },
  overrides: { tone: "formal" },
  priority: 10,
  enabled: false,
};

function makeContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    platform: "slack",
    channelId: "general",
    userId: "user123",
    content: "Hello there",
    timestamp: new Date("2026-04-17T10:30:00"),
    ...overrides,
  };
}

describe("detectPersona", () => {
  it("matches platform trigger", () => {
    const matches = detectPersona([workPersona, casualPersona], makeContext());

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.persona.id).toBe("work");
  });

  it("matches iMessage platform to casual persona", () => {
    const matches = detectPersona(
      [workPersona, casualPersona],
      makeContext({ platform: "imessage" }),
    );

    expect(matches.length).toBe(1);
    expect(matches[0]!.persona.id).toBe("casual");
  });

  it("matches keyword trigger", () => {
    const matches = detectPersona(
      [techPersona],
      makeContext({ content: "Can you review this PR?" }),
    );

    expect(matches.length).toBe(1);
    expect(matches[0]!.persona.id).toBe("tech");
  });

  it("does not match disabled personas", () => {
    const matches = detectPersona([disabledPersona], makeContext());
    expect(matches.length).toBe(0);
  });

  it("returns empty for no matching personas", () => {
    const matches = detectPersona([casualPersona], makeContext({ platform: "discord" }));
    expect(matches.length).toBe(0);
  });

  it("sorts by score then priority", () => {
    // Work matches on platform (1 of 2 triggers: platform + time)
    // Tech matches on keyword (1 of 1 trigger = 100%)
    const matches = detectPersona(
      [workPersona, techPersona],
      makeContext({ content: "deploy this fix" }),
    );

    // Tech has a score of 1.0 (keyword matched, only trigger)
    // Work has a score of 0.5 (platform matched, time may also match)
    expect(matches[0]!.persona.id).toBe("tech");
  });

  it("handles time ranges crossing midnight", () => {
    const nightPersona: Persona = {
      id: "night",
      name: "Night Owl",
      description: "Late night",
      triggers: { timeRanges: ["22:00-06:00"] },
      overrides: { tone: "casual" },
      priority: 1,
      enabled: true,
    };

    // 23:00 should match
    const lateMatches = detectPersona(
      [nightPersona],
      makeContext({ timestamp: new Date("2026-04-17T23:00:00") }),
    );
    expect(lateMatches.length).toBe(1);

    // 03:00 should match
    const earlyMatches = detectPersona(
      [nightPersona],
      makeContext({ timestamp: new Date("2026-04-17T03:00:00") }),
    );
    expect(earlyMatches.length).toBe(1);

    // 12:00 should not match
    const middayMatches = detectPersona(
      [nightPersona],
      makeContext({ timestamp: new Date("2026-04-17T12:00:00") }),
    );
    expect(middayMatches.length).toBe(0);
  });
});

describe("buildPersonaPrompt", () => {
  it("returns empty string for no matches", () => {
    expect(buildPersonaPrompt([])).toBe("");
  });

  it("includes persona name and description", () => {
    const result = buildPersonaPrompt([{ persona: workPersona, score: 1 }]);

    expect(result).toContain("## Active Persona: Work");
    expect(result).toContain("Professional context");
  });

  it("includes style overrides", () => {
    const result = buildPersonaPrompt([{ persona: workPersona, score: 1 }]);

    expect(result).toContain("Tone: professional");
    expect(result).toContain("formal");
    expect(result).toContain("Emoji usage: rare");
  });

  it("shows blending info when multiple personas match", () => {
    const result = buildPersonaPrompt([
      { persona: workPersona, score: 0.8 },
      { persona: techPersona, score: 0.6 },
    ]);

    expect(result).toContain("## Active Persona: Work");
    expect(result).toContain("Blending with");
    expect(result).toContain("Technical");
  });

  it("blends overrides from multiple personas", () => {
    // Work has tone + formality + emojiUsage but no responseLength
    // Tech has tone + formality + responseLength
    // Work is primary, so its tone/formality win. Tech fills in responseLength.
    const result = buildPersonaPrompt([
      { persona: workPersona, score: 0.8 },
      { persona: techPersona, score: 0.6 },
    ]);

    expect(result).toContain("Tone: professional"); // from work (primary)
    expect(result).toContain("Response length: detailed"); // from tech (gap fill)
  });
});
