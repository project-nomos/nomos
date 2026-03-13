/**
 * Deterministic text pre-compression rules.
 *
 * Applied before embedding generation and LLM summarization to reduce
 * token consumption with zero API calls. Each rule is a pure function
 * that transforms text without changing its meaning.
 *
 * Inspired by warengonzaga/tinyclaw's 9-rule pre-compression pipeline.
 */

/**
 * Apply all pre-compression rules to text.
 * Returns compressed text — typically 10-40% smaller.
 */
export function precompress(text: string): string {
  let result = text;
  result = collapseWhitespace(result);
  result = deduplicateLines(result);
  result = removeDecorativeLines(result);
  result = compressMarkdownTables(result);
  result = mergeSimilarBullets(result);
  result = collapseEmptySections(result);
  result = normalizeUnicodePunctuation(result);
  return result.trim();
}

/**
 * Collapse runs of whitespace: multiple spaces → single space,
 * 3+ consecutive blank lines → 2 blank lines.
 */
function collapseWhitespace(text: string): string {
  // Multiple spaces (not at line start for indentation) → single space
  let result = text.replace(/([^\n ]) {2,}/g, "$1 ");
  // 3+ consecutive blank lines → double blank line
  result = result.replace(/\n{4,}/g, "\n\n\n");
  // Trailing whitespace on lines
  result = result.replace(/[ \t]+$/gm, "");
  return result;
}

/**
 * Remove exact duplicate consecutive lines.
 * Keeps the first occurrence.
 */
function deduplicateLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let prev = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prev && trimmed !== "") {
      continue;
    }
    result.push(line);
    prev = trimmed;
  }
  return result.join("\n");
}

/**
 * Remove purely decorative lines: lines made of only dashes, equals,
 * asterisks, underscores, or similar characters (4+ chars).
 */
function removeDecorativeLines(text: string): string {
  return text.replace(/^[ \t]*[-=*_~]{4,}[ \t]*$/gm, "");
}

/**
 * Compress markdown tables to key:value format.
 * Detects tables with header row + separator + data rows.
 */
function compressMarkdownTables(text: string): string {
  // Match markdown table blocks
  const tableRegex = /^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)+)/gm;

  return text.replace(tableRegex, (_match, headerLine: string, _sep, body: string) => {
    const headers = headerLine
      .split("|")
      .map((h: string) => h.trim())
      .filter(Boolean);
    const rows = body
      .trim()
      .split("\n")
      .map((row: string) =>
        row
          .split("|")
          .map((c: string) => c.trim())
          .filter(Boolean),
      );

    // Only compress small tables (≤2 columns, ≤5 rows)
    if (headers.length > 2 || rows.length > 5) return _match;

    return rows
      .map((cells) => cells.map((cell, i) => `${headers[i] ?? ""}: ${cell}`).join(", "))
      .join("\n");
  });
}

/**
 * Merge consecutive bullet points that are very similar (>70% word overlap).
 * Keeps the longer version.
 */
function mergeSimilarBullets(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  const bulletRegex = /^(\s*[-*+]\s+|\s*\d+\.\s+)/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bulletMatch = line.match(bulletRegex);

    if (!bulletMatch) {
      result.push(line);
      i++;
      continue;
    }

    // Look ahead for similar bullets
    const content = line.slice(bulletMatch[0].length).toLowerCase();
    const words = new Set(content.split(/\s+/).filter((w) => w.length > 2));
    let bestLine = line;

    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const nextBulletMatch = nextLine.match(bulletRegex);
      if (!nextBulletMatch) break;

      const nextContent = nextLine.slice(nextBulletMatch[0].length).toLowerCase();
      const nextWords = new Set(nextContent.split(/\s+/).filter((w) => w.length > 2));

      // Calculate Jaccard similarity
      const intersection = new Set([...words].filter((w) => nextWords.has(w)));
      const union = new Set([...words, ...nextWords]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      if (similarity > 0.7) {
        // Keep the longer one
        if (nextLine.length > bestLine.length) {
          bestLine = nextLine;
        }
        i++;
      } else {
        break;
      }
    }

    result.push(bestLine);
    i++;
  }

  return result.join("\n");
}

/**
 * Remove empty markdown sections (heading followed by only whitespace
 * before the next heading or end of text).
 */
function collapseEmptySections(text: string): string {
  // Remove headings followed by nothing until the next heading or EOF
  return text.replace(/^(#{1,6}\s+.+)\n+(?=#{1,6}\s|\s*$)/gm, "");
}

/**
 * Normalize Unicode punctuation to ASCII equivalents.
 * Handles CJK fullwidth punctuation, smart quotes, em dashes, etc.
 */
function normalizeUnicodePunctuation(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // Smart single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // Smart double quotes
    .replace(/[\u2013\u2014]/g, "-") // En/em dashes
    .replace(/\u2026/g, "...") // Ellipsis
    .replace(/\uFF0C/g, ",") // Fullwidth comma
    .replace(/\uFF0E/g, ".") // Fullwidth period
    .replace(/\uFF1A/g, ":") // Fullwidth colon
    .replace(/\uFF1B/g, ";") // Fullwidth semicolon
    .replace(/\uFF01/g, "!") // Fullwidth exclamation
    .replace(/\uFF1F/g, "?"); // Fullwidth question
}
