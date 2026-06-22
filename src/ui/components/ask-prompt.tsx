/**
 * Interactive Ask card for the CLI/Ink REPL — the terminal surface for the
 * native `AskUserQuestion` tool. Renders 1-4 questions one at a time (header +
 * prompt + options), navigated with ↑/↓ or number keys, selected with Enter
 * (Space toggles for multiSelect). Submits one answer per question.
 *
 * State that the keyboard handler reads lives in refs, not React state, so two
 * keystrokes within one render tick (e.g. "pick option 2" then Enter) both see
 * the latest value — `useInput`'s callback would otherwise close over stale
 * state. A render counter forces re-paints after each ref mutation.
 */

import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.ts";

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

interface AskPromptProps {
  questions: AskQuestion[];
  /** Resolves with `{ [question]: answer }`; multiSelect answers join with ", ". */
  onSubmit: (answers: Record<string, string>) => void;
}

export function AskPrompt({ questions, onSubmit }: AskPromptProps): React.ReactElement {
  const qIdx = useRef(0);
  const cursor = useRef(0);
  const picked = useRef<Set<number>>(new Set());
  const answers = useRef<Record<string, string>>({});
  const [, force] = useState(0);
  const repaint = (): void => force((n) => n + 1);

  const q = questions[qIdx.current]!;
  const multi = q.multiSelect ?? false;

  const togglePick = (i: number): void => {
    if (picked.current.has(i)) picked.current.delete(i);
    else picked.current.add(i);
  };

  const confirmQuestion = (): void => {
    const sel = multi
      ? [...picked.current]
      : picked.current.size
        ? [...picked.current]
        : [cursor.current];
    const labels = sel.map((i) => q.options[i]?.label).filter(Boolean) as string[];
    answers.current = { ...answers.current, [q.question]: labels.join(", ") };
    if (qIdx.current + 1 < questions.length) {
      qIdx.current += 1;
      cursor.current = 0;
      picked.current = new Set();
      repaint();
    } else {
      onSubmit(answers.current);
    }
  };

  useInput((input, key) => {
    if (key.upArrow) {
      cursor.current = (cursor.current - 1 + q.options.length) % q.options.length;
      repaint();
    } else if (key.downArrow) {
      cursor.current = (cursor.current + 1) % q.options.length;
      repaint();
    } else if (/^[1-9]$/.test(input)) {
      const i = Number(input) - 1;
      if (i < q.options.length) {
        cursor.current = i;
        if (multi) togglePick(i);
        repaint();
      }
    } else if (input === " " && multi) {
      togglePick(cursor.current);
      repaint();
    } else if (key.return) {
      confirmQuestion();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Text color={theme.status.warning} bold>
          ?{" "}
        </Text>
        <Text dimColor>{q.header ? `${q.header} ` : ""}</Text>
        <Text bold>{q.question}</Text>
        {questions.length > 1 && (
          <Text dimColor>
            {"  "}
            {qIdx.current + 1}/{questions.length}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {q.options.map((opt, i) => {
          const isCursor = i === cursor.current;
          const isPicked = multi && picked.current.has(i);
          const mark = multi ? (isPicked ? "◉" : "○") : isCursor ? "●" : "○";
          return (
            <Box key={i}>
              <Text color={isCursor ? theme.text.link : undefined}>
                {isCursor ? "❯ " : "  "}
                {mark} {opt.label}
              </Text>
              {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
            </Box>
          );
        })}
      </Box>

      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>
          ↑/↓ or 1-{q.options.length} to move{multi ? ", Space to toggle" : ""}, Enter to{" "}
          {qIdx.current + 1 < questions.length ? "next" : "submit"}
        </Text>
      </Box>
    </Box>
  );
}
