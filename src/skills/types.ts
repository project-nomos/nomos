export interface Skill {
  /** Skill name from frontmatter */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Full markdown content (after frontmatter) */
  content: string;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Source: "bundled", "personal", "project" */
  source: string;
  /** Optional emoji to display with skill */
  emoji?: string;
  /** Dependencies required for this skill */
  requires?: {
    bins?: string[];
    os?: string[];
  };
  /** Installation instructions */
  install?: string[];
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  emoji?: string;
  requires?: string;
  install?: string;
  [key: string]: string | undefined;
}
