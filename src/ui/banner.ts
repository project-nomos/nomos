import chalk from "chalk";

// Catppuccin Mocha gradient: Mauve → Blue → Teal
const GRADIENT = ["#CBA6F7", "#B4BEFE", "#89B4FA", "#74C7EC", "#89DCEB"];

// Slanted for an italic feel — each row shifts left by 1 space
const LOGO_LINES = [
  "        ███╗   ██╗  ██████╗  ███╗   ███╗  ██████╗  ███████╗",
  "       ████╗  ██║ ██╔═══██╗ ████╗ ████║ ██╔═══██╗ ██╔════╝",
  "      ██╔██╗ ██║ ██║   ██║ ██╔████╔██║ ██║   ██║ ███████╗",
  "     ██║╚██╗██║ ██║   ██║ ██║╚██╔╝██║ ██║   ██║ ╚════██║",
  "    ██║ ╚████║ ╚██████╔╝ ██║ ╚═╝ ██║ ╚██████╔╝ ███████║",
  "   ╚═╝  ╚═══╝  ╚═════╝  ╚═╝     ╚═╝  ╚═════╝  ╚══════╝",
];

/**
 * Interpolate between two hex colors.
 */
function lerpColor(a: string, b: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/**
 * Apply a horizontal gradient across a string using the GRADIENT palette.
 */
function gradientLine(text: string): string {
  const chars = [...text];
  const len = chars.length;
  if (len === 0) return "";

  const segments = GRADIENT.length - 1;

  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const pos = (i / Math.max(len - 1, 1)) * segments;
      const seg = Math.min(Math.floor(pos), segments - 1);
      const t = pos - seg;
      const color = lerpColor(GRADIENT[seg], GRADIENT[seg + 1], t);
      return chalk.hex(color).bold(ch);
    })
    .join("");
}

export function showBanner(opts: {
  agentName: string;
  agentEmoji?: string;
  version: string;
  model: string;
  sessionKey: string;
  resumedCount?: number;
  upgradeAvailable?: { current: string; latest: string };
}): void {
  const dim = chalk.dim;
  const blue = chalk.hex("#89B4FA");
  const mauve = chalk.hex("#CBA6F7");

  console.log();

  // ASCII logo with gradient
  for (const line of LOGO_LINES) {
    console.log(gradientLine(line));
  }

  // Custom agent name (if not default "Nomos")
  if (opts.agentName !== "Nomos") {
    const nameDisplay = opts.agentEmoji ? `${opts.agentEmoji} ${opts.agentName}` : opts.agentName;
    console.log(mauve.bold(`   ${nameDisplay}`));
  }

  console.log();

  // Tips for getting started (Gemini CLI style)
  console.log(dim("   Tips for getting started:"));
  console.log(dim("   1. Ask questions, edit files, or run commands."));
  console.log(dim("   2. Be specific for the best results."));
  console.log(dim("   3. ") + blue("/help") + dim(" for more information."));

  console.log();

  // Version + model info
  console.log(
    dim(`   v${opts.version}`) + dim(` · ${opts.model}`) + dim(` · session: ${opts.sessionKey}`),
  );

  if (opts.resumedCount && opts.resumedCount > 0) {
    console.log(dim(`   Resumed session with ${opts.resumedCount} messages`));
  }

  if (opts.upgradeAvailable) {
    console.log();
    console.log(
      chalk.hex("#FAB387").bold("   ⬆ Update available: ") +
        dim(`v${opts.upgradeAvailable.current}`) +
        chalk.hex("#FAB387")(" → ") +
        chalk.hex("#A6E3A1").bold(`v${opts.upgradeAvailable.latest}`) +
        dim("  Run: ") +
        blue("brew upgrade nomos"),
    );
  }

  console.log();
}
