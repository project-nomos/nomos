import chalk from "chalk";

const TAGLINES: string[] = [
  // Coding & development
  "Your AI pair programmer",
  "From idea to implementation",
  "I read the docs so you don't have to",
  "Making TODO into DONE",
  "Your codebase whisperer",
  "Less typing, more shipping",
  "The debugger that debugs itself",
  // Channels & communication
  "Slack, Discord, Telegram — one brain",
  "Monitoring your channels, minding your inbox",
  "Every channel, one conversation",
  "Your messages, handled",
  // Meetings & calendar
  "Meetings prepped before you wake up",
  "Calendar briefings on autopilot",
  "You walk in prepared, every time",
  // Email & triage
  "Inbox triaged, drafts ready",
  "Zero unread, zero stress",
  // Memory & context
  "Remembers everything, forgets nothing",
  "Context that carries across every conversation",
  "Your second brain, always online",
  // Autonomy & loops
  "Working in the background so you don't have to",
  "Always on, always thinking",
  "The agent that acts before you ask",
  "Runs while you sleep, reports when you wake",
  // General
  "All your tools, one conversation",
  "Ask me anything, I'll figure it out",
  "Ready when you are",
  "Your terminal, supercharged",
  "One agent, every workflow",
  "Not just another chatbot",
];

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
}): void {
  const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

  console.log();

  // ASCII logo with gradient
  for (const line of LOGO_LINES) {
    console.log(gradientLine(line));
  }

  // Custom agent name (if not default "Nomos")
  if (opts.agentName !== "Nomos") {
    const nameDisplay = opts.agentEmoji ? `${opts.agentEmoji} ${opts.agentName}` : opts.agentName;
    console.log(chalk.hex("#CBA6F7").bold(`   ${nameDisplay}`));
  }

  // Tagline
  console.log(chalk.italic(`   ${chalk.hex("#89B4FA")(tagline)}`));

  // Info line
  console.log(
    chalk.dim(`   v${opts.version}`) +
      chalk.dim(` · ${opts.model}`) +
      chalk.dim(` · session: ${opts.sessionKey}`),
  );

  if (opts.resumedCount && opts.resumedCount > 0) {
    console.log(chalk.dim(`   Resumed session with ${opts.resumedCount} messages`));
  }

  console.log(chalk.dim("   Type /help for commands, /quit to exit\n"));
}
