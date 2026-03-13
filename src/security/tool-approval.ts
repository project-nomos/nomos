export type ApprovalPolicy = "always_ask" | "warn_only" | "block_critical" | "disabled";

export type Severity = "warning" | "critical";

export interface DangerousToolResult {
  dangerous: boolean;
  reason: string;
  severity: Severity;
}

interface DangerousPattern {
  pattern: string | RegExp;
  reason: string;
  severity: Severity;
}

const DANGEROUS_BASH_PATTERNS: DangerousPattern[] = [
  { pattern: /rm\s+-rf/, reason: "Recursive force deletion", severity: "critical" },
  { pattern: /rm\s+-r\s+\//, reason: "Recursive deletion from root", severity: "critical" },
  {
    pattern: /chmod\s+777/,
    reason: "Setting overly permissive file permissions",
    severity: "warning",
  },
  { pattern: /chmod\s+-R/, reason: "Recursive permission changes", severity: "warning" },
  { pattern: /mkfs/, reason: "File system formatting", severity: "critical" },
  { pattern: /dd\s+if=/, reason: "Low-level disk operations", severity: "critical" },
  { pattern: /shutdown/, reason: "System shutdown command", severity: "critical" },
  { pattern: /reboot/, reason: "System reboot command", severity: "critical" },
  { pattern: /kill\s+-9/, reason: "Force kill processes", severity: "warning" },
  { pattern: /pkill/, reason: "Killing processes by name", severity: "warning" },
  { pattern: /sudo/, reason: "Elevated privileges execution", severity: "warning" },
  { pattern: /curl.*\|.*bash/, reason: "Piping remote content to bash", severity: "critical" },
  { pattern: /wget.*\|.*sh/, reason: "Piping remote content to shell", severity: "critical" },
  { pattern: /eval/, reason: "Dynamic code evaluation", severity: "warning" },
  { pattern: /exec/, reason: "Process replacement", severity: "warning" },
];

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env$/,
  /credentials/i,
  /id_rsa/,
  /\.ssh\//,
  /\/etc\//,
  /\.pem$/,
  /\.key$/,
  /password/i,
  /secret/i,
];

const DANGEROUS_GIT_PATTERNS: DangerousPattern[] = [
  { pattern: /push\s+--force/, reason: "Force push to remote", severity: "critical" },
  { pattern: /push\s+-f/, reason: "Force push to remote", severity: "critical" },
  { pattern: /reset\s+--hard/, reason: "Hard reset discards local changes", severity: "warning" },
  {
    pattern: /clean\s+-fd/,
    reason: "Force clean untracked files and directories",
    severity: "warning",
  },
  {
    pattern: /branch\s+-D\s+(main|master)/,
    reason: "Deleting main/master branch",
    severity: "critical",
  },
];

export class ToolApprovalChecker {
  /**
   * Checks if a tool execution is considered dangerous
   * @param toolName - The name of the tool being executed
   * @param args - The arguments passed to the tool
   * @returns Information about whether the operation is dangerous
   */
  isDangerous(toolName: string, args: Record<string, unknown>): DangerousToolResult {
    // Check Bash commands
    if (toolName === "Bash" || toolName === "bash") {
      return this.checkBashCommand(args);
    }

    // Check file operations
    if (toolName === "Write" || toolName === "Edit") {
      return this.checkFileOperation(args);
    }

    // Check git operations
    if (toolName === "git") {
      return this.checkGitOperation(args);
    }

    // Check network operations
    if (toolName === "curl" || toolName === "wget") {
      return this.checkNetworkOperation(args);
    }

    return { dangerous: false, reason: "", severity: "warning" };
  }

  private checkBashCommand(args: Record<string, unknown>): DangerousToolResult {
    const command = String(args.command || "");

    // Check against dangerous bash patterns
    for (const { pattern, reason, severity } of DANGEROUS_BASH_PATTERNS) {
      if (typeof pattern === "string") {
        if (command.includes(pattern)) {
          return { dangerous: true, reason, severity };
        }
      } else if (pattern.test(command)) {
        return { dangerous: true, reason, severity };
      }
    }

    // Check for data exfiltration patterns (curl/wget with POST and file content)
    if (
      (command.includes("curl") || command.includes("wget")) &&
      (command.includes("POST") || command.includes("-X POST") || command.includes("--data"))
    ) {
      if (command.includes("cat") || command.includes("<")) {
        return {
          dangerous: true,
          reason: "Potential data exfiltration via network request with file content",
          severity: "critical",
        };
      }
    }

    return { dangerous: false, reason: "", severity: "warning" };
  }

  private checkFileOperation(args: Record<string, unknown>): DangerousToolResult {
    const filePath = String(args.file_path || args.path || "");

    // Check against sensitive file patterns
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          dangerous: true,
          reason: `Writing to sensitive file: ${filePath}`,
          severity: "warning",
        };
      }
    }

    // Check for system directories
    if (
      filePath.startsWith("/etc/") ||
      filePath.startsWith("/sys/") ||
      filePath.startsWith("/proc/")
    ) {
      return {
        dangerous: true,
        reason: `Writing to system directory: ${filePath}`,
        severity: "critical",
      };
    }

    return { dangerous: false, reason: "", severity: "warning" };
  }

  private checkGitOperation(args: Record<string, unknown>): DangerousToolResult {
    const command = String(args.command || args.args || "");

    // Check against dangerous git patterns
    for (const { pattern, reason, severity } of DANGEROUS_GIT_PATTERNS) {
      if (typeof pattern === "string") {
        if (command.includes(pattern)) {
          return { dangerous: true, reason, severity };
        }
      } else if (pattern.test(command)) {
        return { dangerous: true, reason, severity };
      }
    }

    return { dangerous: false, reason: "", severity: "warning" };
  }

  private checkNetworkOperation(args: Record<string, unknown>): DangerousToolResult {
    const url = String(args.url || "");
    const data = String(args.data || args.body || "");

    // Check for POST requests with data
    if (data && (args.method === "POST" || String(args.options || "").includes("POST"))) {
      return {
        dangerous: true,
        reason: "Network POST request with data payload",
        severity: "warning",
      };
    }

    // Check for suspicious domains
    if (url.match(/^https?:\/\/(?!github\.com|gitlab\.com|npmjs\.com|pypi\.org)/)) {
      if (data) {
        return {
          dangerous: true,
          reason: "Sending data to external domain",
          severity: "warning",
        };
      }
    }

    return { dangerous: false, reason: "", severity: "warning" };
  }

  /**
   * Determines if a tool should be executed based on the approval policy
   * @param policy - The approval policy to apply
   * @param result - The danger check result
   * @returns true if the tool should be executed without prompting, false if it should be blocked or require approval
   */
  shouldExecute(policy: ApprovalPolicy, result: DangerousToolResult): boolean {
    if (policy === "disabled") {
      return true;
    }

    if (!result.dangerous) {
      return true;
    }

    if (policy === "warn_only") {
      return true;
    }

    if (policy === "block_critical" && result.severity === "warning") {
      return true;
    }

    // always_ask and block_critical with critical severity require approval
    return false;
  }
}
