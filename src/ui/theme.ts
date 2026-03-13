/**
 * Semantic color theme for the terminal UI.
 * Inspired by Gemini CLI's theme system.
 * Uses hex colors for truecolor terminals (Catppuccin Mocha palette).
 */

export const theme = {
  text: {
    /** Terminal default — leave undefined for ink to use default */
    primary: undefined as string | undefined,
    /** Muted metadata, secondary info */
    secondary: "gray",
    /** AI identity color (purple) — used for ✦ prefix, agent name */
    accent: "#CBA6F7",
    /** Links, references, interactive elements (blue) */
    link: "#89B4FA",
    /** User input highlight (green) */
    user: "#A6E3A1",
  },
  border: {
    /** Default border for tool boxes, dividers */
    default: "gray",
    /** Active/executing tool border */
    active: "#F9E2AF",
    /** Focused/highlighted border */
    focused: "#89B4FA",
  },
  status: {
    /** Success — tool completed, checks passed */
    success: "#A6E3A1",
    /** Warning — executing, pending */
    warning: "#F9E2AF",
    /** Error — tool failed, errors */
    error: "#F38BA8",
  },
  /** Unicode symbols used throughout the UI */
  symbol: {
    /** User input prompt */
    user: ">",
    /** AI response prefix */
    nomos: "✦",
    /** Tool completed successfully */
    toolSuccess: "✓",
    /** Tool currently executing */
    toolRunning: "⊷",
    /** Tool failed */
    toolError: "✗",
    /** System message prefix */
    system: "─",
  },
  /** Gradient colors for the animated spinner (cycles through these) */
  gradient: ["#CBA6F7", "#89B4FA", "#89DCEB", "#A6E3A1", "#F9E2AF", "#F38BA8"],
} as const;
