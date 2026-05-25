/**
 * Unicode block-based progress bar with smooth sub-character resolution.
 * Uses eighth-block characters (▏▎▍▌▋▊▉█) for 8x resolution.
 * Inspired by Claude Code's ProgressBar.
 */

import React from "react";
import { Text } from "ink";

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

interface ProgressBarProps {
  /** Progress value (0 to 1) */
  value: number;
  /** Width in characters (default: 20) */
  width?: number;
  /** Fill color */
  color?: string;
  /** Background color for unfilled portion */
  bgColor?: string;
  /** Show percentage label */
  showPercent?: boolean;
}

function ProgressBarInner({
  value,
  width = 20,
  color = "#89B4FA",
  bgColor,
  showPercent = false,
}: ProgressBarProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(1, value));
  const totalUnits = width * 8;
  const filledUnits = Math.round(clamped * totalUnits);

  const fullBlocks = Math.floor(filledUnits / 8);
  const remainder = filledUnits % 8;

  let bar = BLOCKS[8].repeat(fullBlocks);
  if (remainder > 0 && fullBlocks < width) {
    bar += BLOCKS[remainder];
  }

  const emptyWidth = width - fullBlocks - (remainder > 0 ? 1 : 0);
  const empty = " ".repeat(Math.max(0, emptyWidth));

  const percent = Math.round(clamped * 100);

  return (
    <>
      <Text color={color}>{bar}</Text>
      <Text color={bgColor} dimColor={!bgColor}>
        {empty}
      </Text>
      {showPercent && <Text dimColor> {percent}%</Text>}
    </>
  );
}

export const ProgressBar = React.memo(ProgressBarInner);
