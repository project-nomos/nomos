import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir, formatSkillsForPrompt } from "./loader.ts";
import type { Skill } from "./types.ts";

describe("loadSkillsFromDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads skills from a directory", () => {
    // Create a skill directory structure
    const skillDir = path.join(tmpDir, "test-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: test-skill
description: "A test skill"
---

# Test Skill

Do the thing.`,
    );

    const skills = loadSkillsFromDir(tmpDir, "test");

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test-skill");
    expect(skills[0].description).toBe("A test skill");
    expect(skills[0].content).toContain("# Test Skill");
    expect(skills[0].source).toBe("test");
    expect(skills[0].filePath).toBe(path.join(skillDir, "SKILL.md"));
  });

  it("uses directory name when frontmatter has no name", () => {
    const skillDir = path.join(tmpDir, "my-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Just content, no frontmatter.");

    const skills = loadSkillsFromDir(tmpDir, "test");

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
  });

  it("skips directories without SKILL.md", () => {
    const noSkillDir = path.join(tmpDir, "not-a-skill");
    fs.mkdirSync(noSkillDir);
    fs.writeFileSync(path.join(noSkillDir, "README.md"), "Not a skill.");

    const skills = loadSkillsFromDir(tmpDir, "test");

    expect(skills).toHaveLength(0);
  });

  it("skips hidden directories", () => {
    const hiddenDir = path.join(tmpDir, ".hidden-skill");
    fs.mkdirSync(hiddenDir);
    fs.writeFileSync(path.join(hiddenDir, "SKILL.md"), "---\nname: hidden\n---\nContent.");

    const skills = loadSkillsFromDir(tmpDir, "test");

    expect(skills).toHaveLength(0);
  });

  it("returns empty array for non-existent directory", () => {
    const skills = loadSkillsFromDir("/tmp/does-not-exist-xyz", "test");
    expect(skills).toHaveLength(0);
  });

  it("loads multiple skills", () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const skillDir = path.join(tmpDir, name);
      fs.mkdirSync(skillDir);
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: "${name} skill"\n---\n\n# ${name}`,
      );
    }

    const skills = loadSkillsFromDir(tmpDir, "test");

    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("formatSkillsForPrompt", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("formats skills as catalog with file paths", () => {
    const skills: Skill[] = [
      {
        name: "github",
        description: "GitHub integration",
        content: "Use gh CLI.",
        filePath: "/skills/github/SKILL.md",
        source: "bundled",
      },
    ];

    const result = formatSkillsForPrompt(skills);

    expect(result).toContain("## Skills");
    expect(result).toContain("1 skill(s) available");
    expect(result).toContain("**github**");
    expect(result).toContain("GitHub integration");
    expect(result).toContain("/skills/github/SKILL.md");
    // Body content is NOT included (progressive disclosure)
    expect(result).not.toContain("Use gh CLI.");
  });

  it("formats multiple skills as list items", () => {
    const skills: Skill[] = [
      {
        name: "a",
        description: "Skill A",
        content: "Content A.",
        filePath: "/a/SKILL.md",
        source: "bundled",
      },
      {
        name: "b",
        description: "Skill B",
        content: "Content B.",
        filePath: "/b/SKILL.md",
        source: "bundled",
      },
    ];

    const result = formatSkillsForPrompt(skills);

    expect(result).toContain("2 skill(s) available");
    expect(result).toContain("**a**");
    expect(result).toContain("**b**");
  });

  it("includes emoji in skill name when present", () => {
    const skills: Skill[] = [
      {
        name: "github",
        description: "GitHub integration",
        content: "Use gh CLI.",
        filePath: "/skills/github/SKILL.md",
        source: "bundled",
        emoji: "🐙",
      },
    ];

    const result = formatSkillsForPrompt(skills);

    expect(result).toContain("**🐙 github**");
    expect(result).toContain("GitHub integration");
  });

  it("handles skills without emoji", () => {
    const skills: Skill[] = [
      {
        name: "github",
        description: "GitHub integration",
        content: "Use gh CLI.",
        filePath: "/skills/github/SKILL.md",
        source: "bundled",
      },
    ];

    const result = formatSkillsForPrompt(skills);

    expect(result).toContain("**github**");
    expect(result).not.toContain("**🐙");
  });
});
