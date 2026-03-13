import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

const codeStyle = chalk.hex("#89DCEB");
const linkStyle = chalk.hex("#89B4FA");
const hrefStyle = chalk.hex("#89B4FA").underline;

// Configure marked with terminal renderer once at module load
marked.use(
  markedTerminal({
    // Code styling
    code: codeStyle,
    codespan: codeStyle,
    // Headings
    firstHeading: chalk.bold.underline,
    heading: chalk.bold,
    // Text formatting
    strong: chalk.bold,
    em: chalk.italic,
    del: chalk.dim.strikethrough,
    // Links
    link: linkStyle,
    href: hrefStyle,
    // Structural
    blockquote: chalk.gray.italic,
    hr: chalk.dim,
    listitem: chalk.reset,
    table: chalk.reset,
    paragraph: chalk.reset,
    // Options
    reflowText: false,
    showSectionPrefix: false,
    width: Math.min(process.stdout.columns || 80, 120),
    tab: 2,
    emoji: false,
    unescape: true,
  }),
);

/**
 * Fix inline formatting that marked-terminal misses inside list items.
 * marked-terminal v7 + marked v15 has a bug where inline renderers
 * (strong, em, codespan, link) are not called within list items.
 * Paragraphs are processed correctly, so this only affects unprocessed text.
 */
function fixInlineFormatting(text: string): string {
  return (
    text
      // Code spans: `text` → styled (process first to protect contents)
      .replace(/`([^`]+)`/g, (_, code: string) => codeStyle(code))
      // Bold: **text** → bold
      .replace(/\*\*(.+?)\*\*/g, (_, content: string) => chalk.bold(content))
      // Links: [text](url) → styled
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, label: string, url: string) =>
          linkStyle(label + " (") + hrefStyle(url) + linkStyle(")"),
      )
      // Italic: *text* — single stars, not at line start (bullet points)
      .replace(/(?<=\s|^)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/gm, (_, content: string) =>
        chalk.italic(content),
      )
  );
}

/**
 * Render a markdown string to ANSI-formatted terminal output.
 * Returns the rendered string with trailing whitespace trimmed.
 */
export function renderMarkdown(text: string): string {
  if (!text.trim()) return "";

  try {
    let rendered = marked.parse(text) as string;
    // Fix inline formatting missed by marked-terminal in list items
    rendered = fixInlineFormatting(rendered);
    // marked-terminal adds trailing newlines; trim them
    return rendered.replace(/\n+$/, "");
  } catch {
    // Fall back to raw text on parse errors
    return text;
  }
}
