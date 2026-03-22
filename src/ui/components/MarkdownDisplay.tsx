import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { formatInline, padToWidth, visibleLength } from "../markdown-utils.ts";

interface MarkdownDisplayProps {
  /** Raw markdown text (already stripped of unsafe characters). */
  text: string;
  /** Available width in columns (excluding outer chrome like the ✦ prefix). */
  width?: number;
}

// ─── Block types ────────────────────────────────────────────────

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string }
  | { type: "ulist"; items: string[] }
  | { type: "olist"; items: string[]; start: number }
  | { type: "blockquote"; text: string }
  | { type: "hr" }
  | {
      type: "table";
      headers: string[];
      alignments: ("left" | "center" | "right")[];
      rows: string[][];
    }
  | { type: "empty" };

// ─── Parser ─────────────────────────────────────────────────────

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line
    if (line.trim() === "") {
      // Collapse consecutive empty lines
      if (blocks.length === 0 || blocks[blocks.length - 1].type !== "empty") {
        blocks.push({ type: "empty" });
      }
      i++;
      continue;
    }

    // Fenced code block
    const codeMatch = line.match(/^(`{3,}|~{3,})\s*([\w+-]*)/);
    if (codeMatch) {
      const fence = codeMatch[1];
      const language = codeMatch[2] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    // Heading (ATX style)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Table (requires header + separator + at least one row)
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      const headerCells = parsePipeLine(line);
      const separatorCells = parsePipeLine(lines[i + 1]);
      const alignments = separatorCells.map((cell): "left" | "center" | "right" => {
        const trimmed = cell.trim();
        if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
        if (trimmed.endsWith(":")) return "right";
        return "left";
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(parsePipeLine(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers: headerCells, alignments, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    // Unordered list
    const ulistMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ulistMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+])\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[3]);
          i++;
        } else if (lines[i].match(/^\s{2,}/) && items.length > 0) {
          // Continuation line
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "ulist", items });
      continue;
    }

    // Ordered list
    const olistMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olistMatch) {
      const start = parseInt(olistMatch[2], 10);
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)\d+\.\s+(.*)$/);
        if (itemMatch) {
          items.push(itemMatch[2]);
          i++;
        } else if (lines[i].match(/^\s{2,}/) && items.length > 0) {
          // Continuation line
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "olist", items, start });
      continue;
    }

    // Paragraph (default) — collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^(#{1,6}\s|```|~~~|>|[-*+]\s|\d+\.\s|---\s*$|___\s*$|\*\*\*\s*$)/) &&
      !isTableStart(lines, i)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join("\n") });
    }
  }

  return blocks;
}

function isTableStart(lines: string[], idx: number): boolean {
  return (
    lines[idx].includes("|") &&
    idx + 1 < lines.length &&
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[idx + 1])
  );
}

function parsePipeLine(line: string): string[] {
  // Strip leading/trailing pipes and split
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

// ─── Renderers ──────────────────────────────────────────────────

function HeadingBlock({ level, text }: { level: number; text: string }): React.ReactElement {
  const formatted = formatInline(text);
  if (level === 1) {
    return (
      <Box marginTop={1}>
        <Text bold underline>
          {formatted}
        </Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text bold>{formatted}</Text>
    </Box>
  );
}

function CodeBlock({
  language,
  code,
  width,
}: {
  language: string;
  code: string;
  width: number;
}): React.ReactElement {
  let highlighted: string;
  try {
    if (language && supportsLanguage(language)) {
      highlighted = highlight(code, { language });
    } else {
      highlighted = highlight(code, {});
    }
  } catch {
    highlighted = code;
  }

  const label = language ? chalk.dim(` ${language} `) : "";
  const innerWidth = Math.max(width - 4, 20); // account for border + padding

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
      width={Math.min(innerWidth + 4, width)}
    >
      {label && (
        <Box justifyContent="flex-end">
          <Text>{label}</Text>
        </Box>
      )}
      <Text wrap="truncate">{highlighted}</Text>
    </Box>
  );
}

function UnorderedListBlock({ items }: { items: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item, idx) => (
        <Box key={idx} paddingLeft={1}>
          <Text>
            {chalk.dim("•")} {formatInline(item)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function OrderedListBlock({
  items,
  start,
}: {
  items: string[];
  start: number;
}): React.ReactElement {
  // Compute width of widest number for alignment
  const maxNum = start + items.length - 1;
  const numWidth = String(maxNum).length;

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const num = String(start + idx).padStart(numWidth, " ");
        return (
          <Box key={idx} paddingLeft={1}>
            <Text>
              {chalk.dim(num + ".")} {formatInline(item)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function BlockquoteBlock({ text }: { text: string }): React.ReactElement {
  return (
    <Box
      marginLeft={1}
      borderStyle="single"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor="gray"
      paddingLeft={1}
    >
      <Text italic dimColor wrap="wrap">
        {formatInline(text)}
      </Text>
    </Box>
  );
}

function HorizontalRule({ width }: { width: number }): React.ReactElement {
  return (
    <Box marginY={0}>
      <Text dimColor>{"─".repeat(Math.min(width, 80))}</Text>
    </Box>
  );
}

function TableBlock({
  headers,
  alignments,
  rows,
}: {
  headers: string[];
  alignments: ("left" | "center" | "right")[];
  rows: string[][];
}): React.ReactElement {
  // Calculate column widths
  const colCount = headers.length;
  const colWidths: number[] = headers.map((h) => visibleLength(formatInline(h)));

  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      const len = visibleLength(formatInline(cell));
      if (len > (colWidths[c] ?? 0)) {
        colWidths[c] = len;
      }
    }
  }

  const formatRow = (cells: string[]): string => {
    return cells
      .map((cell, c) => {
        const formatted = formatInline(cell);
        const w = colWidths[c] ?? 10;
        const alignment = alignments[c] ?? "left";
        const stripped = visibleLength(formatted);
        const pad = Math.max(0, w - stripped);

        if (alignment === "right") return " ".repeat(pad) + formatted;
        if (alignment === "center") {
          const left = Math.floor(pad / 2);
          const right = pad - left;
          return " ".repeat(left) + formatted + " ".repeat(right);
        }
        return padToWidth(formatted, w);
      })
      .join(chalk.dim(" │ "));
  };

  const separator = colWidths.map((w) => "─".repeat(w)).join(chalk.dim("─┼─"));

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>{formatRow(headers)}</Text>
      <Text dimColor>{separator}</Text>
      {rows.map((row, idx) => (
        <Text key={idx}>{formatRow(row)}</Text>
      ))}
    </Box>
  );
}

// ─── Main component ─────────────────────────────────────────────

function MarkdownDisplayInner({ text, width }: MarkdownDisplayProps): React.ReactElement {
  const effectiveWidth = width ?? Math.min((process.stdout.columns || 80) - 2, 120);

  if (!text.trim()) {
    return <Text>{""}</Text>;
  }

  const blocks = parseBlocks(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "heading":
            return <HeadingBlock key={idx} level={block.level} text={block.text} />;
          case "code":
            return (
              <CodeBlock
                key={idx}
                language={block.language}
                code={block.code}
                width={effectiveWidth}
              />
            );
          case "ulist":
            return <UnorderedListBlock key={idx} items={block.items} />;
          case "olist":
            return <OrderedListBlock key={idx} items={block.items} start={block.start} />;
          case "blockquote":
            return <BlockquoteBlock key={idx} text={block.text} />;
          case "hr":
            return <HorizontalRule key={idx} width={effectiveWidth} />;
          case "table":
            return (
              <TableBlock
                key={idx}
                headers={block.headers}
                alignments={block.alignments}
                rows={block.rows}
              />
            );
          case "empty":
            return <Box key={idx} height={1} />;
          case "paragraph":
            return (
              <Text key={idx} wrap="wrap">
                {formatInline(block.text)}
              </Text>
            );
        }
      })}
    </Box>
  );
}

export const MarkdownDisplay = React.memo(MarkdownDisplayInner);
