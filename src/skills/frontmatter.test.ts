import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses valid frontmatter with name and description", () => {
    const content = `---
name: github
description: "Interact with GitHub using the gh CLI."
---

# GitHub Skill

Use the gh CLI.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("github");
    expect(result.frontmatter.description).toBe("Interact with GitHub using the gh CLI.");
    expect(result.body).toBe("# GitHub Skill\n\nUse the gh CLI.");
  });

  it("handles single-quoted values", () => {
    const content = `---
name: 'weather'
description: 'Get the weather forecast.'
---

Content here.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("weather");
    expect(result.frontmatter.description).toBe("Get the weather forecast.");
  });

  it("handles unquoted values", () => {
    const content = `---
name: my-skill
description: A simple skill
---

Body text.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A simple skill");
  });

  it("returns empty frontmatter when no --- delimiter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";

    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("returns empty frontmatter when closing --- is missing", () => {
    const content = "---\nname: broken\nNo closing delimiter.";

    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("skips nested YAML lines (not simple key: value)", () => {
    const content = `---
name: github
description: "GitHub skill"
metadata:
  openclaw:
    emoji: octopus
---

Body.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("github");
    expect(result.frontmatter.description).toBe("GitHub skill");
    // Nested lines are skipped
    expect(result.frontmatter.metadata).toBeUndefined();
    expect(result.body).toBe("Body.");
  });

  it("handles Windows-style line endings", () => {
    const content = "---\r\nname: test\r\ndescription: A test\r\n---\r\n\r\nBody.";

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("test");
    expect(result.frontmatter.description).toBe("A test");
    expect(result.body).toBe("Body.");
  });

  it("handles empty body after frontmatter", () => {
    const content = `---
name: empty
---`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("empty");
    expect(result.body).toBe("");
  });

  it("parses emoji field", () => {
    const content = `---
name: bear-notes
description: "Query Bear notes"
emoji: "🐻"
---

Content.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("bear-notes");
    expect(result.frontmatter.emoji).toBe("🐻");
  });

  it("parses requires field with nested bins and os", () => {
    const content = `---
name: bear-notes
description: "Query Bear notes"
requires:
  bins: ["grizzly"]
  os: ["darwin"]
---

Content.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("bear-notes");
    expect(result.frontmatter.requires).toBeDefined();
    const requires = JSON.parse(result.frontmatter.requires!);
    expect(requires.bins).toEqual(["grizzly"]);
    expect(requires.os).toEqual(["darwin"]);
  });

  it("parses install field with array of commands", () => {
    const content = `---
name: bear-notes
description: "Query Bear notes"
install:
  - "go install github.com/tylerwince/grizzly/cmd/grizzly@latest"
  - "echo 'Installation complete'"
---

Content.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("bear-notes");
    expect(result.frontmatter.install).toBeDefined();
    const install = JSON.parse(result.frontmatter.install!);
    expect(install).toEqual([
      "go install github.com/tylerwince/grizzly/cmd/grizzly@latest",
      "echo 'Installation complete'",
    ]);
  });

  it("parses all metadata fields together", () => {
    const content = `---
name: bear-notes
description: "Query Bear notes"
emoji: "🐻"
requires:
  bins: ["grizzly"]
  os: ["darwin"]
install:
  - "go install github.com/tylerwince/grizzly/cmd/grizzly@latest"
---

# Bear Notes Skill

Content here.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("bear-notes");
    expect(result.frontmatter.description).toBe("Query Bear notes");
    expect(result.frontmatter.emoji).toBe("🐻");

    const requires = JSON.parse(result.frontmatter.requires!);
    expect(requires.bins).toEqual(["grizzly"]);
    expect(requires.os).toEqual(["darwin"]);

    const install = JSON.parse(result.frontmatter.install!);
    expect(install).toEqual(["go install github.com/tylerwince/grizzly/cmd/grizzly@latest"]);

    expect(result.body).toBe("# Bear Notes Skill\n\nContent here.");
  });
});
