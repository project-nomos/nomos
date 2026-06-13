import { describe, it, expect } from "vitest";
import { curateConsumerSkills, resolveSkillName, isConsumerSkill } from "./skill-view.ts";
import type { Skill } from "./types.ts";

function skill(name: string, source: string, description = ""): Skill {
  return { name, description, content: "", filePath: `/x/${name}/SKILL.md`, source };
}

// Mirrors the real hosted catalog: operator external (Google) + bundled consumer
// + bundled dev/internal/channel skills that must be hidden.
const ALL: Skill[] = [
  skill(
    "google-calendar-meeting-prep",
    "external",
    "Build a practical meeting prep brief from a connected Google Calendar that is long enough to need truncation.",
  ),
  skill("gmail-inbox-triage", "external", "Triage a Gmail inbox into actionable buckets."),
  skill("google-drive", "external", "Find, read, and organize files in Google Drive."),
  skill("pdf", "bundled", "Work with PDF files."),
  skill("xlsx", "bundled", "Read and write spreadsheets."),
  skill("run-evals", "bundled", "Run the Nomos eval suite."),
  skill("self-improve", "bundled", "Clone the repo and improve the code."),
  skill("skill-creator", "bundled", "Create new skills."),
  skill("slack", "bundled", "Interact with Slack workspaces."),
];

describe("isConsumerSkill", () => {
  it("accepts external + allowlisted bundled, rejects dev/internal/channel", () => {
    expect(isConsumerSkill(skill("google-drive", "external"))).toBe(true);
    expect(isConsumerSkill(skill("pdf", "bundled"))).toBe(true);
    expect(isConsumerSkill(skill("run-evals", "bundled"))).toBe(false);
    expect(isConsumerSkill(skill("slack", "bundled"))).toBe(false);
    expect(isConsumerSkill(skill("skill-creator", "bundled"))).toBe(false);
  });
});

describe("curateConsumerSkills", () => {
  it("surfaces only consumer skills, under friendly labels", () => {
    const names = curateConsumerSkills(ALL, () => true).map((s) => s.name);
    expect(names).toEqual(["Drive", "Inbox triage", "Meeting prep", "PDF tools", "Spreadsheets"]);
  });

  it("hides every dev/internal/channel skill", () => {
    const out = curateConsumerSkills(ALL, () => true);
    for (const raw of ["run-evals", "self-improve", "skill-creator", "slack"]) {
      expect(out.some((s) => resolveSkillName(ALL, s.name) === raw)).toBe(false);
    }
  });

  it("badges google skills 'google' and bundled consumer skills 'built-in'", () => {
    const out = curateConsumerSkills(ALL, () => true);
    expect(out.find((s) => s.name === "Drive")?.source).toBe("google");
    expect(out.find((s) => s.name === "PDF tools")?.source).toBe("built-in");
  });

  it("folds the persisted enabled state in (default on)", () => {
    const off = new Set(["pdf"]);
    const out = curateConsumerSkills(ALL, (n) => !off.has(n));
    expect(out.find((s) => s.name === "PDF tools")?.enabled).toBe(false);
    expect(out.find((s) => s.name === "Drive")?.enabled).toBe(true);
  });

  it("truncates long descriptions", () => {
    const mp = curateConsumerSkills(ALL, () => true).find((s) => s.name === "Meeting prep");
    expect(mp!.description.length).toBeLessThanOrEqual(88);
    expect(mp!.description.endsWith("...")).toBe(true);
  });

  it("sanitizes em dashes out of consumer-facing descriptions", () => {
    const out = curateConsumerSkills(
      [skill("weather", "bundled", "Forecasts — no API key needed.")],
      () => true,
    );
    expect(out[0].description).not.toContain("—");
    expect(out[0].description).toBe("Forecasts - no API key needed.");
  });
});

describe("resolveSkillName", () => {
  it("round-trips a friendly label back to the raw skill name for toggling", () => {
    expect(resolveSkillName(ALL, "Meeting prep")).toBe("google-calendar-meeting-prep");
    expect(resolveSkillName(ALL, "PDF tools")).toBe("pdf");
    expect(resolveSkillName(ALL, "Drive")).toBe("google-drive");
  });

  it("falls back to the input when no friendly label matches", () => {
    expect(resolveSkillName(ALL, "already-raw")).toBe("already-raw");
  });
});
