import { execSync } from "node:child_process";
import { loadSkills } from "./loader.ts";
import type { Skill } from "./types.ts";

/**
 * Structured representation of an install command
 */
export interface InstallSpec {
  /** Type of installation handler */
  handler: "brew" | "npm" | "pip" | "cargo" | "curl";
  /** Package name or URL */
  target: string;
  /** Original raw command */
  raw: string;
}

/**
 * Parse an install command string into a structured InstallSpec
 */
export function parseInstallSpec(installStr: string): InstallSpec {
  const trimmed = installStr.trim();

  // Homebrew: brew install <pkg> or brew tap <repo> && brew install <pkg>
  if (trimmed.includes("brew install")) {
    const match = trimmed.match(/brew install\s+([^\s&|]+)/);
    if (match) {
      return {
        handler: "brew",
        target: match[1],
        raw: trimmed,
      };
    }
  }

  // npm: npm install -g <pkg>
  if (trimmed.match(/npm install -g/)) {
    const match = trimmed.match(/npm install -g\s+([^\s&|]+)/);
    if (match) {
      return {
        handler: "npm",
        target: match[1],
        raw: trimmed,
      };
    }
  }

  // pip: pip install <pkg>
  if (trimmed.match(/pip install/)) {
    const match = trimmed.match(/pip install\s+([^\s&|]+)/);
    if (match) {
      return {
        handler: "pip",
        target: match[1],
        raw: trimmed,
      };
    }
  }

  // cargo: cargo install <pkg>
  if (trimmed.match(/cargo install/)) {
    const match = trimmed.match(/cargo install\s+([^\s&|]+)/);
    if (match) {
      return {
        handler: "cargo",
        target: match[1],
        raw: trimmed,
      };
    }
  }

  // curl: curl -L <url> -o <path>
  if (trimmed.match(/curl.*-L/)) {
    const match = trimmed.match(/curl.*-L\s+([^\s]+)/);
    if (match) {
      return {
        handler: "curl",
        target: match[1],
        raw: trimmed,
      };
    }
  }

  // Fallback: treat as raw command (first token is handler)
  const firstToken = trimmed.split(/\s+/)[0];
  return {
    handler: firstToken as any,
    target: trimmed,
    raw: trimmed,
  };
}

/**
 * Skill dependency installer
 */
export class SkillInstaller {
  private dryRun: boolean;

  constructor(dryRun = false) {
    this.dryRun = dryRun || process.env.SKILL_INSTALL_DRY_RUN === "true";
  }

  /**
   * Check which required binaries are missing for a skill
   */
  checkDependencies(skill: Skill): { missing: string[]; available: string[] } {
    const bins = skill.requires?.bins ?? [];
    const missing: string[] = [];
    const available: string[] = [];

    for (const bin of bins) {
      if (this.isOnPath(bin)) {
        available.push(bin);
      } else {
        missing.push(bin);
      }
    }

    return { missing, available };
  }

  /**
   * Install dependencies for a skill
   */
  async install(skill: Skill): Promise<{ success: boolean; output: string }> {
    if (!skill.install || skill.install.length === 0) {
      return {
        success: false,
        output: `No install instructions found for skill "${skill.name}"`,
      };
    }

    const outputs: string[] = [];

    for (const installCmd of skill.install) {
      const spec = parseInstallSpec(installCmd);

      if (this.dryRun) {
        outputs.push(`[DRY RUN] Would execute: ${spec.raw}`);
        continue;
      }

      try {
        outputs.push(`Running: ${spec.raw}`);
        const result = execSync(spec.raw, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        outputs.push(result);
      } catch (error: any) {
        return {
          success: false,
          output: outputs.join("\n") + `\n\nError: ${error.message}\n${error.stderr || ""}`,
        };
      }
    }

    return {
      success: true,
      output: outputs.join("\n"),
    };
  }

  /**
   * Install dependencies for all skills with missing binaries
   */
  async installAll(skills: Skill[]): Promise<Map<string, { success: boolean; output: string }>> {
    const results = new Map<string, { success: boolean; output: string }>();

    for (const skill of skills) {
      const { missing } = this.checkDependencies(skill);
      if (missing.length > 0) {
        const result = await this.install(skill);
        results.set(skill.name, result);
      }
    }

    return results;
  }

  /**
   * Check if a binary is available on PATH
   */
  private isOnPath(bin: string): boolean {
    try {
      execSync(`which ${bin}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const doInstall = args.includes("--install");

  console.log("Scanning skills...\n");

  const skills = loadSkills();
  const installer = new SkillInstaller(process.env.SKILL_INSTALL_DRY_RUN === "true");

  const skillsWithMissingDeps: Array<{
    skill: Skill;
    missing: string[];
  }> = [];

  for (const skill of skills) {
    const { missing, available } = installer.checkDependencies(skill);

    if (missing.length > 0) {
      skillsWithMissingDeps.push({ skill, missing });
      console.log(`❌ ${skill.name}: missing ${missing.join(", ")}`);
      if (available.length > 0) {
        console.log(`   ✅ available: ${available.join(", ")}`);
      }
      if (skill.install) {
        console.log(`   📦 install: ${skill.install.join(" && ")}`);
      }
      console.log();
    }
  }

  if (skillsWithMissingDeps.length === 0) {
    console.log("✅ All skill dependencies are satisfied!\n");
    return;
  }

  console.log(`Found ${skillsWithMissingDeps.length} skill(s) with missing dependencies.\n`);

  if (checkOnly) {
    console.log("Check complete (use --install to install).\n");
    return;
  }

  if (!doInstall) {
    console.log("Run with --install to install missing dependencies.\n");
    return;
  }

  console.log("Installing missing dependencies...\n");

  for (const { skill, missing } of skillsWithMissingDeps) {
    console.log(`Installing ${skill.name} (${missing.join(", ")})...`);
    const result = await installer.install(skill);

    if (result.success) {
      console.log(`✅ Success\n`);
    } else {
      console.log(`❌ Failed:\n${result.output}\n`);
    }
  }

  console.log("Installation complete.\n");
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
