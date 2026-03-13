import React, { useState, useEffect } from "react";
import { Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "../theme.ts";

interface GradientSpinnerProps {
  /** Optional text label shown after the spinner */
  label?: string;
}

/**
 * Animated spinner that cycles through theme gradient colors.
 * Inspired by Gemini CLI's GeminiSpinner.
 */
export function GradientSpinner({ label }: GradientSpinnerProps): React.ReactElement {
  const [colorIndex, setColorIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setColorIndex((prev) => (prev + 1) % theme.gradient.length);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const color = theme.gradient[colorIndex];

  return (
    <>
      <Text color={color}>
        <Spinner type="dots" />
      </Text>
      {label && <Text dimColor>{" " + label}</Text>}
    </>
  );
}
