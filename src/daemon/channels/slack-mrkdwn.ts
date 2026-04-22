/**
 * Convert standard Markdown to Slack's mrkdwn format.
 *
 * Key differences:
 *   Markdown          Slack mrkdwn
 *   **bold**       -> *bold*
 *   *italic*       -> _italic_
 *   _italic_       -> _italic_ (same)
 *   [text](url)    -> <url|text>
 *   # Heading      -> *Heading*
 *   ## Heading     -> *Heading*
 *   > quote        -> > quote (same)
 *   `code`         -> `code` (same)
 *   ```code```     -> ```code``` (same)
 *   ~~strike~~     -> ~strike~
 */
export function markdownToSlackMrkdwn(text: string): string {
  let result = text;

  // Protect code blocks from conversion (extract, convert around them, re-insert)
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00INLINE${inlineCode.length - 1}\x00`;
  });

  // Headers: # Heading -> *Heading* (bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** -> *text* (must be done before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Bold: __text__ -> *text*
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Italic: *text* -> _text_ (only single asterisks not already converted)
  // This is tricky -- after bold conversion, remaining single * pairs are italic
  // Skip if already handled as bold (no double *)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Horizontal rules: --- or *** -> ———
  result = result.replace(/^[-*]{3,}$/gm, "———");

  // Restore inline code
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCode[Number(i)]);

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return result;
}
