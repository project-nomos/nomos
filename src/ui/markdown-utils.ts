import chalk from "chalk";

/** Catppuccin Mocha colors matching theme.ts */
const CODE_COLOR = "#89DCEB";
const LINK_COLOR = "#89B4FA";

/**
 * Convert inline markdown formatting to ANSI-styled strings via chalk.
 *
 * Processing order matters — code spans are handled first to protect
 * their contents from bold/italic/link processing.
 */
export function formatInline(text: string): string {
  // 1. Protect and convert code spans: `text`
  const codeSpans: string[] = [];
  let result = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const placeholder = `\x00CODE${codeSpans.length}\x00`;
    codeSpans.push(chalk.hex(CODE_COLOR)(code));
    return placeholder;
  });

  // 2. Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_, content: string) => chalk.bold(content));
  result = result.replace(/__(.+?)__/g, (_, content: string) => chalk.bold(content));

  // 3. Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_, content: string) => chalk.dim.strikethrough(content));

  // 4. Links: [label](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, url: string) =>
      chalk.hex(LINK_COLOR)(label) + " " + chalk.hex(LINK_COLOR).underline(url),
  );

  // 5. Italic: *text* (not at line start to avoid bullet conflicts)
  result = result.replace(/(?<!\*)\*(?!\s|\*)(.+?)(?<!\s)\*(?!\*)/g, (_, content: string) =>
    chalk.italic(content),
  );

  // 6. Italic: _text_ (not inside words)
  result = result.replace(
    /(?<![a-zA-Z0-9])_(?!\s)(.+?)(?<!\s)_(?![a-zA-Z0-9])/g,
    (_, content: string) => chalk.italic(content),
  );

  // 7. Restore code spans
  for (let i = 0; i < codeSpans.length; i++) {
    result = result.replace(`\x00CODE${i}\x00`, codeSpans[i]);
  }

  return result;
}

/**
 * Pad/truncate a string to exactly the given width.
 * Used for table column alignment.
 */
export function padToWidth(text: string, width: number): string {
  // oxlint-disable-next-line no-control-regex -- intentional ANSI escape stripping
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const len = stripped.length;
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

/**
 * Get the visible (non-ANSI) length of a string.
 */
export function visibleLength(text: string): number {
  // oxlint-disable-next-line no-control-regex -- intentional ANSI escape stripping
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
