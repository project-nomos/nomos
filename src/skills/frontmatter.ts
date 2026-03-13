import type { ParsedFrontmatter } from "./types.ts";

/**
 * Parse YAML frontmatter from a markdown file.
 * Handles simple key: value pairs and limited nested structures for skill metadata.
 * This is intentionally simple to avoid adding a yaml dependency.
 */
export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trimStart();
  const frontmatter: ParsedFrontmatter = {};

  const lines = block.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Handle simple key: value pairs
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();

      // Handle empty value (nested object or array follows)
      if (value === "") {
        i++;
        // Check if this is 'requires' or 'install'
        if (key === "requires") {
          const requiresData: { bins?: string[]; os?: string[] } = {};
          while (i < lines.length && lines[i].match(/^\s{2,}/)) {
            const nestedMatch = lines[i].match(/^\s+([\w-]+):\s*(.*)$/);
            if (nestedMatch) {
              const nestedKey = nestedMatch[1];
              const nestedValue = nestedMatch[2].trim();
              if (nestedKey === "bins" || nestedKey === "os") {
                requiresData[nestedKey] = parseArrayValue(nestedValue);
                // Check for multi-line array
                i++;
                while (i < lines.length && lines[i].match(/^\s{4,}-\s*/)) {
                  const arrayItem = lines[i].match(/^\s+-\s*"?([^"]+)"?$/);
                  if (arrayItem && requiresData[nestedKey]) {
                    requiresData[nestedKey]!.push(arrayItem[1].trim());
                  }
                  i++;
                }
                continue;
              }
            }
            i++;
          }
          frontmatter[key] = JSON.stringify(requiresData);
          continue;
        } else if (key === "install") {
          const installLines: string[] = [];
          while (i < lines.length && lines[i].match(/^\s{2,}-\s*/)) {
            const arrayMatch = lines[i].match(/^\s+-\s*"?([^"]+)"?$/);
            if (arrayMatch) {
              installLines.push(arrayMatch[1].trim());
            }
            i++;
          }
          frontmatter[key] = JSON.stringify(installLines);
          continue;
        }
      } else {
        // Strip surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        frontmatter[key] = value;
      }
    }
    i++;
  }

  return { frontmatter, body };
}

/**
 * Parse inline array notation like ["grizzly"] or single values
 */
function parseArrayValue(value: string): string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    return inner
      .split(",")
      .map((item) => {
        let trimmed = item.trim();
        if (
          (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ) {
          trimmed = trimmed.slice(1, -1);
        }
        return trimmed;
      })
      .filter(Boolean);
  }
  return [];
}
