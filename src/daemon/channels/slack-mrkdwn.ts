/**
 * Convert standard Markdown to Slack's "mrkdwn" format.
 *
 * Slack does NOT speak CommonMark. It has its own dialect, so agent output
 * (which is normal Markdown) has to be translated or it renders wrong:
 *
 *   Markdown              Slack mrkdwn
 *   **bold**           -> *bold*
 *   __bold__           -> *bold*
 *   *italic* / _it_    -> _italic_
 *   # Heading          -> *Heading*        (Slack has no headings)
 *   - item / * item    -> bullet item      (Slack shows the raw marker otherwise)
 *   [text](url)        -> <url|text>
 *   ![alt](url)        -> alt              (Slack can't inline images in text)
 *   ~~strike~~         -> ~strike~
 *   ```lang\ncode```   -> ```\ncode```      (Slack renders the lang tag as a line)
 *   `code`             -> `code`           (same)
 *   > quote            -> > quote          (same)
 *   :emoji:            -> :emoji:          (Slack renders these natively)
 *
 * Ordering matters: italic (single *…*) must run BEFORE any rule that emits
 * single-asterisk bold (headings, bold), otherwise the freshly-written `*bold*`
 * gets re-read as italic and rendered _italic_.
 */

// Sentinel that wraps protected spans so no real text collides. U+E000 is in the
// Unicode Private Use Area; built via fromCharCode to keep the source pure ASCII.
const S = String.fromCharCode(0xe000);
const BULLET = "•"; // •
const SUB_BULLET = "◦"; // ◦
const DIVIDER = "─".repeat(10); // ──────────

export function markdownToSlackMrkdwn(text: string): string {
  let result = text;

  // 1. Protect fenced code blocks. Slack ignores the language identifier on the
  //    opening fence and renders it as the first line INSIDE the block, so drop
  //    it. Everything between the fences is kept verbatim (no markdown applied).
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const normalized = match.replace(/^```[^\n`]*\r?\n/, "```\n");
    codeBlocks.push(normalized);
    return `${S}C${codeBlocks.length - 1}${S}`;
  });

  // 2. Protect inline code so markdown inside it stays literal.
  const inlineCode: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCode.push(match);
    return `${S}I${inlineCode.length - 1}${S}`;
  });

  // 3. Horizontal rules (---, ***, ___, optionally spaced) -> a divider line.
  result = result.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, DIVIDER);

  // 4. Bullets (-, *, +) -> bullet char, nested (indented) -> hollow bullet,
  //    preserving indentation. Done before italic so a leading "* " marker isn't
  //    read as emphasis.
  result = result.replace(/^([ \t]*)[-*+][ \t]+/gm, (_m, indent: string) => {
    const depth = indent.replace(/\t/g, "  ").length;
    return `${indent}${depth >= 2 ? SUB_BULLET : BULLET} `;
  });

  // 5. Italic FIRST. Single *…* with no adjacent '*' so **bold** is left
  //    untouched (its leading "*" fails the (?!\*) guard, its content can't start
  //    with "*"). Underscore italic (_x_) is already valid Slack mrkdwn.
  result = result.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "_$1_");

  // 6. Headings (# .. ######) -> *bold*. After italic so the result survives.
  result = result.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "*$1*");

  // 7. Bold: **text** / __text__ -> *text*. After italic so the result survives.
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // 8. Links: [text](url) -> <url|text>; images ![alt](url) -> alt.
  result = result.replace(
    /(!?)\[([^\]]+)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g,
    (_m, bang: string, label: string, url: string) => (bang ? label : `<${url}|${label}>`),
  );

  // 9. Strikethrough: ~~text~~ -> ~text~.
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Restore protected spans (inline first, then blocks).
  result = result.replace(new RegExp(`${S}I(\\d+)${S}`, "g"), (_m, i) => inlineCode[Number(i)]);
  result = result.replace(new RegExp(`${S}C(\\d+)${S}`, "g"), (_m, i) => codeBlocks[Number(i)]);

  return result;
}
