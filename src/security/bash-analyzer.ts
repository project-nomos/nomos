/**
 * Bash command analysis for safety checking.
 *
 * Provides lightweight parsing and analysis of bash commands to detect
 * potentially dangerous operations. Used by the tool approval system
 * to flag risky commands before execution.
 *
 * Adapted from Claude Code's bash utilities — simplified to focus on
 * safety-relevant analysis without the full AST parser.
 */

// ── Dangerous Patterns ──

/** Commands that modify system state in ways that are hard to reverse. */
const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mkfs",
  "dd",
  "shred",
  "wipefs",
  "fdisk",
  "parted",
]);

/** Commands that affect package management / system config. */
const SYSTEM_COMMANDS = new Set([
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "brew",
  "snap",
  "pip",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "gem",
  "systemctl",
  "launchctl",
  "service",
]);

/** Commands that send data over the network. */
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "nc",
  "netcat",
  "ncat",
  "telnet",
]);

/** Git operations that can lose data. */
const DESTRUCTIVE_GIT_OPS = new Set([
  "push --force",
  "push -f",
  "reset --hard",
  "clean -f",
  "clean -fd",
  "clean -fdx",
  "checkout .",
  "checkout -- .",
  "branch -D",
  "stash drop",
  "stash clear",
  "rebase",
]);

/** Dangerous flag patterns. */
const DANGEROUS_FLAGS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b.*\s-[rR]f?\s/, reason: "Recursive file deletion" },
  { pattern: /\brm\b.*\s-f[rR]?\s/, reason: "Force file deletion" },
  { pattern: /\bchmod\b.*\s777\b/, reason: "World-writable permissions" },
  { pattern: /\bchmod\b.*\s-R\b/, reason: "Recursive permission change" },
  { pattern: /\bchown\b.*\s-R\b/, reason: "Recursive ownership change" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "Writing to block device" },
  { pattern: /\bsudo\b/, reason: "Elevated privileges" },
  { pattern: /\bsu\b\s/, reason: "Switch user" },
  { pattern: /\|.*\bsh\b/, reason: "Piping to shell" },
  { pattern: /\|.*\bbash\b/, reason: "Piping to bash" },
  { pattern: /\beval\b/, reason: "Dynamic code evaluation" },
  { pattern: /`[^`]+`/, reason: "Command substitution in backticks" },
  { pattern: /\$\([^)]+\)/, reason: "Command substitution" },
];

// ── Analysis Types ──

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export interface CommandAnalysis {
  /** The original command string. */
  command: string;
  /** Overall risk level. */
  risk: RiskLevel;
  /** Individual risk factors found. */
  risks: Array<{ level: RiskLevel; reason: string }>;
  /** The base command(s) extracted. */
  baseCommands: string[];
  /** Whether the command modifies files. */
  modifiesFiles: boolean;
  /** Whether the command accesses the network. */
  accessesNetwork: boolean;
  /** Whether the command uses elevated privileges. */
  elevated: boolean;
  /** Whether the command is a git operation that can lose data. */
  destructiveGit: boolean;
}

// ── Analysis Functions ──

/**
 * Analyze a bash command for safety risks.
 */
export function analyzeBashCommand(command: string): CommandAnalysis {
  const risks: Array<{ level: RiskLevel; reason: string }> = [];
  const baseCommands = extractBaseCommands(command);
  let modifiesFiles = false;
  let accessesNetwork = false;
  let elevated = false;
  let destructiveGit = false;

  // Check for destructive commands
  for (const base of baseCommands) {
    if (DESTRUCTIVE_COMMANDS.has(base)) {
      risks.push({ level: "high", reason: `Destructive command: ${base}` });
      modifiesFiles = true;
    }
    if (SYSTEM_COMMANDS.has(base)) {
      risks.push({ level: "medium", reason: `System command: ${base}` });
    }
    if (NETWORK_COMMANDS.has(base)) {
      risks.push({ level: "low", reason: `Network command: ${base}` });
      accessesNetwork = true;
    }
  }

  // Check for dangerous git operations
  for (const gitOp of DESTRUCTIVE_GIT_OPS) {
    if (command.includes(`git ${gitOp}`)) {
      risks.push({ level: "high", reason: `Destructive git operation: git ${gitOp}` });
      destructiveGit = true;
    }
  }

  // Check for dangerous flag patterns
  for (const { pattern, reason } of DANGEROUS_FLAGS) {
    if (pattern.test(command)) {
      const level =
        reason.includes("sudo") || reason.includes("Piping to")
          ? ("high" as RiskLevel)
          : ("medium" as RiskLevel);
      risks.push({ level, reason });
      if (reason.includes("sudo") || reason.includes("su")) elevated = true;
    }
  }

  // Check for file redirection that could overwrite
  if (/>\s*[^>|]/.test(command) && !command.includes(">>")) {
    risks.push({ level: "low", reason: "File overwrite via redirection" });
    modifiesFiles = true;
  }

  // Check for environment variable manipulation
  if (/\bexport\b/.test(command) || /\bunset\b/.test(command)) {
    risks.push({ level: "low", reason: "Environment variable modification" });
  }

  // Determine overall risk
  const risk = computeOverallRisk(risks);

  return {
    command,
    risk,
    risks,
    baseCommands,
    modifiesFiles,
    accessesNetwork,
    elevated,
    destructiveGit,
  };
}

/**
 * Quick check — is a command potentially dangerous?
 */
export function isDangerous(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  return analysis.risk === "high" || analysis.risk === "critical";
}

/**
 * Extract base command names from a command string.
 * Handles pipes, &&, ||, and semicolons.
 */
export function extractBaseCommands(command: string): string[] {
  const commands: string[] = [];

  // Split on pipes, &&, ||, ; while handling basic quoting
  const parts = splitCommand(command);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract the first word (the command name)
    // Skip environment variable assignments (FOO=bar cmd)
    const words = trimmed.split(/\s+/);
    for (const word of words) {
      if (word.includes("=") && !word.startsWith("-")) continue;
      // Strip path prefix
      const base = word.replace(/^.*\//, "");
      if (base) {
        commands.push(base);
        break;
      }
    }
  }

  return commands;
}

// ── Helpers ──

/**
 * Split a command string on operators (|, &&, ||, ;)
 * while respecting basic quoting.
 */
function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "|" || ch === ";") {
        parts.push(current);
        current = "";
        // Skip || and &&
        if (ch === "|" && command[i + 1] === "|") i++;
        continue;
      }
      if (ch === "&" && command[i + 1] === "&") {
        parts.push(current);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) parts.push(current);
  return parts;
}

function computeOverallRisk(risks: Array<{ level: RiskLevel }>): RiskLevel {
  if (risks.length === 0) return "safe";

  const levels: Record<RiskLevel, number> = {
    safe: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  let maxLevel: RiskLevel = "safe";
  for (const risk of risks) {
    if (levels[risk.level] > levels[maxLevel]) {
      maxLevel = risk.level;
    }
  }

  // Multiple medium risks escalate to high
  const mediumCount = risks.filter((r) => r.level === "medium").length;
  if (mediumCount >= 3 && maxLevel === "medium") {
    return "high";
  }

  return maxLevel;
}
