/**
 * Spinner with glimmer animation and stalled state detection.
 * Inspired by Claude Code's SpinnerAnimationRow + GlimmerMessage.
 *
 * Modes: requesting, thinking, responding, tool-use
 * After 3s of no token updates, transitions to a "stalled" visual.
 */

import React, { useState, useEffect, useRef } from "react";
import { Text } from "ink";
import { theme } from "../theme.ts";

export type SpinnerMode = "requesting" | "thinking" | "responding" | "tool-use";

interface StalledSpinnerProps {
  /** Current spinner mode */
  mode: SpinnerMode;
  /** Label text to display with shimmer effect */
  label?: string;
  /** Timestamp of last token received (Date.now()) */
  lastTokenAt?: number;
  /** Stall threshold in ms (default: 3000) */
  stallThresholdMs?: number;
}

// Spinner frame characters — platform-adaptive
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Colors
const STALLED_COLOR = "#F38BA8"; // Catppuccin red

function interpolateColor(c1: string, c2: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(c1);
  const [r2, g2, b2] = parse(c2);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function StalledSpinnerInner({
  mode,
  label,
  lastTokenAt,
  stallThresholdMs = 3000,
}: StalledSpinnerProps): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [time, setTime] = useState(Date.now());
  const startRef = useRef(Date.now());

  // Animation loop — 80ms for spinner, also drives shimmer + stall
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
      setTime(Date.now());
    }, 80);
    return () => clearInterval(interval);
  }, []);

  // Stall detection
  const elapsed = time - (lastTokenAt ?? startRef.current);
  const isStalled = elapsed > stallThresholdMs;
  const stallIntensity = isStalled
    ? Math.min(1, (elapsed - stallThresholdMs) / 2000) // fade over 2s
    : 0;

  // Spinner glyph color — fades to red when stalled
  const baseColor = modeColor(mode);
  const spinnerColor = isStalled
    ? interpolateColor(baseColor, STALLED_COLOR, stallIntensity)
    : baseColor;

  // Shimmer on label text
  const glimmerSpeed = mode === "requesting" ? 50 : 200;
  const glimmerPos = Math.floor((time - startRef.current) / glimmerSpeed);

  const labelChars = label ? [...label] : [];
  const shimmerColor = isStalled ? STALLED_COLOR : "#CBA6F7"; // mauve shimmer

  return (
    <>
      <Text color={spinnerColor}>{SPINNER_FRAMES[frame]}</Text>
      <Text> </Text>
      {labelChars.length > 0 &&
        labelChars.map((ch, i) => {
          if (ch === " ") return <Text key={i}> </Text>;
          const dist = Math.abs((glimmerPos % labelChars.length) - i);
          const isShimmer = dist <= 1;
          const charColor = isShimmer
            ? shimmerColor
            : isStalled
              ? interpolateColor("#999999", STALLED_COLOR, stallIntensity)
              : "#999999";
          return (
            <Text key={i} color={charColor}>
              {ch}
            </Text>
          );
        })}
    </>
  );
}

function modeColor(mode: SpinnerMode): string {
  switch (mode) {
    case "requesting":
      return theme.gradient[0]; // mauve
    case "thinking":
      return theme.gradient[1]; // blue
    case "responding":
      return theme.gradient[3]; // green
    case "tool-use":
      return theme.gradient[4]; // yellow
  }
}

export const StalledSpinner = React.memo(StalledSpinnerInner);
