import chalk from "chalk";
import { loadUserProfile, loadAgentIdentity } from "../config/profile.ts";
import { getConfigValue, setConfigValue, listConfig } from "../db/config.ts";
import { deleteLastTranscriptMessages } from "../db/transcripts.ts";
import { getSession, updateSessionModel } from "../db/sessions.ts";
import { loadMcpConfig } from "../cli/mcp-config.ts";
import { loadSkills } from "../skills/loader.ts";
import { loadAgentConfigs, getActiveAgent } from "../config/agents.ts";
import type { NomosConfig } from "../config/env.ts";
import type { McpServerConfig } from "../sdk/session.ts";

/** Static registry of slash commands for autocomplete and dispatch. */
export const SLASH_COMMANDS = [
  { name: "help", desc: "Show available commands" },
  { name: "clear", desc: "Clear conversation context" },
  { name: "compact", desc: "Compact conversation" },
  { name: "model", desc: "Show/switch model" },
  { name: "thinking", desc: "Set thinking level" },
  { name: "sandbox", desc: "Toggle sandbox mode" },
  { name: "status", desc: "System status overview" },
  { name: "context", desc: "Context usage estimate" },
  { name: "cost", desc: "Session token usage" },
  { name: "history", desc: "Conversation summary" },
  { name: "undo", desc: "Remove last exchange" },
  { name: "copy", desc: "Copy last response to clipboard" },
  { name: "profile", desc: "View/edit user profile" },
  { name: "identity", desc: "View/edit agent identity" },
  { name: "skills", desc: "List loaded skills" },
  { name: "agent", desc: "List/switch agent configs" },
  { name: "config", desc: "List runtime settings" },
  { name: "tools", desc: "List available tools" },
  { name: "mcp", desc: "List MCP servers" },
  { name: "memory", desc: "Search/add to memory" },
  { name: "session", desc: "Show session info" },
  { name: "drafts", desc: "List pending draft responses" },
  { name: "approve", desc: "Approve a draft response" },
  { name: "reject", desc: "Reject a draft response" },
  { name: "slack", desc: "List connected Slack workspaces" },
  { name: "permissions", desc: "Manage agent permissions" },
  { name: "integrations", desc: "Setup channel integrations" },
  { name: "team", desc: "Run a task with parallel agent workers" },
  { name: "quit", desc: "Exit nomos" },
] as const;

/** Mutable runtime state that commands can read/modify. */
export interface CommandState {
  model: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
  sandboxEnabled?: boolean;
  activeAgentId?: string;
}

/** Context passed to every slash command handler. */
export interface CommandContext {
  transcript: Array<{ role: string; content: string }>;
  session: { id: string; session_key: string };
  state: CommandState;
  config: NomosConfig;
  mcpServers: Record<string, McpServerConfig>;
}

export interface CommandResult {
  output: string;
  quit?: boolean;
  /** Signal to compact the conversation */
  compact?: boolean;
  /** Signal to pass the original input through to the agent as a user message */
  passthrough?: string;
}

/** Available models for /model picker */
function getAvailableModels(): Array<{ id: string; label: string; desc: string }> {
  return [
    { id: "claude-opus-4-6", label: "Opus 4", desc: "most capable" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4", desc: "fast, balanced" },
    { id: "claude-haiku-4-5", label: "Haiku 4", desc: "fastest, cheapest" },
  ];
}

/**
 * Dispatch a slash command and return the output as a string.
 */
export async function dispatchSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  if (!cmd) {
    return { output: cmdHelp() };
  }

  switch (cmd) {
    case "quit":
    case "exit":
    case "q":
      return { output: "", quit: true };
    case "help":
      return { output: cmdHelp() };
    case "clear":
      return { output: cmdClear(ctx) };
    case "model":
      return { output: await cmdModel(ctx, args) };
    case "thinking":
    case "think-hard":
    case "ultrathink":
      return { output: cmdThinking(ctx, args, cmd) };
    case "sandbox":
      return { output: cmdSandbox(ctx, args) };
    case "session":
      return { output: await cmdSession(ctx) };
    case "memory":
      return { output: await cmdMemory(ctx, args) };
    case "config":
      return { output: await cmdConfig(args) };
    case "tools":
      return { output: cmdTools(ctx) };
    case "cost":
      return { output: await cmdCost(ctx) };
    case "history":
      return { output: cmdHistory(ctx) };
    case "undo":
      return { output: await cmdUndo(ctx) };
    case "copy":
      return { output: await cmdCopy(ctx) };
    case "mcp":
      return { output: await cmdMcp(ctx) };
    case "profile":
      return { output: await cmdProfile(args) };
    case "identity":
      return { output: await cmdIdentity(args) };
    case "skills":
      return { output: await cmdSkills(args) };
    case "compact":
      return cmdCompact(ctx);
    case "status":
      return { output: await cmdStatus(ctx) };
    case "context":
      return { output: cmdContext(ctx) };
    case "agent":
      return { output: await cmdAgent(ctx, args) };
    case "drafts":
      return { output: await cmdDrafts() };
    case "approve":
      return { output: await cmdApproveDraft(args) };
    case "reject":
      return { output: await cmdRejectDraft(args) };
    case "slack":
      return { output: await cmdSlackWorkspaces() };
    case "permissions":
      return { output: await cmdPermissions(args) };
    case "integrations":
      return { output: await cmdIntegrations(ctx, args) };
    case "team":
      return cmdTeam(args, input);
    case "undo-files":
      return { output: cmdUndoFiles() };
    default:
      return {
        output: chalk.yellow(`Unknown command: /${cmd}. Type /help for available commands.`),
      };
  }
}

// ---------------------------------------------------------------------------
// Individual command handlers — all return strings
// ---------------------------------------------------------------------------

function cmdHelp(): string {
  const lines = [
    chalk.bold("Session"),
    "  /clear             Clear conversation context",
    "  /compact           Compact conversation to reduce context",
    "  /status            Show system status overview",
    "  /context           Show context usage estimate",
    "  /cost              Show session token usage",
    "  /history           Show conversation summary",
    "  /undo              Remove last exchange",
    "  /undo-files        Revert file changes (placeholder)",
    "  /copy              Copy last response to clipboard",
    "",
    chalk.bold("Model"),
    "  /model             Show current model and available options",
    "  /model <name|num>  Switch model by name or number",
    "  /thinking          Show/set thinking level (off/minimal/low/medium/high/max)",
    "  /sandbox           Show/toggle sandbox mode (on/off)",
    "",
    chalk.bold("Profile"),
    "  /profile           View user profile",
    "  /identity          View agent identity",
    "  /skills            List loaded skills",
    "  /agent             List/switch agent configs",
    "",
    chalk.bold("Drafts"),
    "  /drafts            List pending draft responses",
    "  /approve <id>      Approve a draft and send as user",
    "  /reject <id>       Reject a draft response",
    "",
    chalk.bold("Teams"),
    "  /team <task>       Run a task with parallel agent workers",
    "",
    chalk.bold("Config"),
    "  /config            List runtime settings",
    "  /tools             List available tools",
    "  /mcp               List MCP servers",
    "  /memory            Search or add to memory",
    "  /permissions       Manage agent permissions",
    "  /integrations      Setup channel integrations",
    "",
    chalk.bold("Exit"),
    "  /quit  /exit  /q   Exit nomos",
  ];
  return lines.join("\n");
}

function cmdClear(ctx: CommandContext): string {
  ctx.transcript.length = 0;
  return chalk.dim("Conversation cleared (session preserved in DB)");
}

async function cmdModel(ctx: CommandContext, args: string[]): Promise<string> {
  const input = args[0];

  if (!input) {
    // Show current model + available list
    const lines = [chalk.dim(`Current model: ${ctx.state.model}`), ""];
    for (let i = 0; i < getAvailableModels().length; i++) {
      const m = getAvailableModels()[i];
      const current = m.id === ctx.state.model ? chalk.green(" ← current") : "";
      lines.push(
        `  ${chalk.bold(String(i + 1))}. ${chalk.cyan(m.id)}  ${chalk.dim(m.label)} ${chalk.dim(`(${m.desc})`)}${current}`,
      );
    }
    lines.push("", chalk.dim("Use /model <number> or /model <name> to switch."));
    return lines.join("\n");
  }

  // Try numeric selection first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= getAvailableModels().length) {
    const selected = getAvailableModels()[num - 1];
    ctx.state.model = selected.id;
    await updateSessionModel(ctx.session.id, selected.id);
    return chalk.dim(`Model switched to: ${selected.id} (${selected.label})`);
  }

  // Try fuzzy match on label or id
  const lower = input.toLowerCase();
  const match = getAvailableModels().find(
    (m) => m.id.toLowerCase().includes(lower) || m.label.toLowerCase().includes(lower),
  );
  if (match) {
    ctx.state.model = match.id;
    await updateSessionModel(ctx.session.id, match.id);
    return chalk.dim(`Model switched to: ${match.id} (${match.label})`);
  }

  // Fallback: accept any model string directly
  ctx.state.model = input;
  await updateSessionModel(ctx.session.id, input);
  return chalk.dim(`Model switched to: ${input}`);
}

function cmdThinking(ctx: CommandContext, args: string[], cmd: string): string {
  // Handle aliases
  if (cmd === "think-hard") {
    ctx.state.thinkingLevel = "low";
    return chalk.dim("Thinking level set to: low");
  }
  if (cmd === "ultrathink") {
    ctx.state.thinkingLevel = "high";
    return chalk.dim("Thinking level set to: high");
  }

  const validLevels = ["off", "minimal", "low", "medium", "high", "max"];
  const input = args[0];

  // Show current level if no argument
  if (!input) {
    const current = ctx.state.thinkingLevel ?? "high";
    const lines = [
      chalk.dim(`Current thinking level: ${current}`),
      "",
      chalk.bold("Available levels:"),
      `  ${chalk.cyan("off")}      - No extended thinking`,
      `  ${chalk.cyan("minimal")}  - Minimal thinking (1K tokens)`,
      `  ${chalk.cyan("low")}      - Low thinking (2K tokens)`,
      `  ${chalk.cyan("medium")}   - Medium thinking (5K tokens)`,
      `  ${chalk.cyan("high")}     - High/adaptive thinking (default)`,
      `  ${chalk.cyan("max")}      - Maximum thinking (32K tokens)`,
      "",
      chalk.dim("Aliases: /think-hard (low), /ultrathink (high)"),
      chalk.dim("Use /thinking <level> to change."),
    ];
    return lines.join("\n");
  }

  // Validate and set level
  const level = input.toLowerCase();
  if (!validLevels.includes(level)) {
    return chalk.yellow(`Invalid level: ${input}. Valid: ${validLevels.join(", ")}`);
  }

  ctx.state.thinkingLevel = level as typeof ctx.state.thinkingLevel;
  return chalk.dim(`Thinking level set to: ${level}`);
}

function cmdSandbox(ctx: CommandContext, args: string[]): string {
  const input = args[0];

  // Show current status if no argument
  if (!input) {
    const current = ctx.state.sandboxEnabled ?? false;
    const status = current ? chalk.green("enabled") : chalk.red("disabled");
    const lines = [
      chalk.dim(`Sandbox mode: ${status}`),
      "",
      chalk.dim("Use /sandbox on or /sandbox off to toggle."),
      chalk.dim("When enabled, code execution runs in an isolated sandbox environment."),
    ];
    return lines.join("\n");
  }

  // Toggle sandbox mode
  const normalized = input.toLowerCase();
  if (normalized === "on" || normalized === "enable" || normalized === "enabled") {
    ctx.state.sandboxEnabled = true;
    return chalk.dim("Sandbox mode enabled. Code will run in isolated environment.");
  } else if (normalized === "off" || normalized === "disable" || normalized === "disabled") {
    ctx.state.sandboxEnabled = false;
    return chalk.dim("Sandbox mode disabled. Code runs in standard environment.");
  } else {
    return chalk.yellow(`Invalid option: ${input}. Use 'on' or 'off'.`);
  }
}

async function cmdSession(ctx: CommandContext): Promise<string> {
  const row = await getSession(ctx.session.id);
  const lines = [
    chalk.dim(`Session:  ${ctx.session.session_key}`),
    chalk.dim(`Model:    ${ctx.state.model}`),
    chalk.dim(`Messages: ${ctx.transcript.length} in memory`),
  ];
  if (row?.token_usage) {
    lines.push(
      chalk.dim(`Usage:    ${row.token_usage.input} input / ${row.token_usage.output} output`),
    );
  }
  return lines.join("\n");
}

async function cmdProfile(args: string[]): Promise<string> {
  if (!args[0] || args[0] !== "set") {
    const profile = await loadUserProfile();
    const lines = [
      chalk.bold("User Profile:"),
      chalk.dim(`  Name:         ${profile.name ?? "(not set)"}`),
      chalk.dim(`  Timezone:     ${profile.timezone ?? "(not set)"}`),
      chalk.dim(`  Workspace:    ${profile.workspace ?? "(not set)"}`),
      chalk.dim(`  Instructions: ${profile.instructions ?? "(not set)"}`),
      chalk.dim("\nUse /profile set <key> <value> to update. Restart to apply."),
    ];
    return lines.join("\n");
  }

  const key = args[1];
  const value = args.slice(2).join(" ");
  const validKeys = ["name", "timezone", "workspace", "instructions"];
  if (!key || !validKeys.includes(key)) {
    return chalk.yellow(`Valid keys: ${validKeys.join(", ")}`);
  }
  if (!value) {
    return chalk.yellow(`Usage: /profile set ${key} <value>`);
  }
  await setConfigValue(`user.${key}`, value);
  return chalk.dim(`Set user.${key} = ${value}\nRestart the session to apply.`);
}

async function cmdIdentity(args: string[]): Promise<string> {
  if (!args[0] || args[0] !== "set") {
    const identity = await loadAgentIdentity();
    const lines = [
      chalk.bold("Agent Identity:"),
      chalk.dim(`  Name:  ${identity.name}`),
      chalk.dim(`  Emoji: ${identity.emoji ?? "(none)"}`),
      chalk.dim("\nUse /identity set <key> <value> to update. Restart to apply."),
    ];
    return lines.join("\n");
  }

  const key = args[1];
  const value = args.slice(2).join(" ");
  if (key !== "name" && key !== "emoji") {
    return chalk.yellow("Valid keys: name, emoji");
  }
  if (!value) {
    return chalk.yellow(`Usage: /identity set ${key} <value>`);
  }
  await setConfigValue(`agent.${key}`, value);
  return chalk.dim(`Set agent.${key} = ${value}\nRestart the session to apply.`);
}

async function cmdSkills(args: string[]): Promise<string> {
  const skills = loadSkills();

  if (!args[0]) {
    if (skills.length === 0) {
      return chalk.dim("No skills loaded.\nAdd skills to ~/.nomos/skills/ or ./skills/");
    }
    const lines = [chalk.bold(`Skills (${skills.length}):`)];
    for (const skill of skills) {
      const displayName = skill.emoji ? `${skill.emoji} ${skill.name}` : skill.name;
      lines.push(`  ${chalk.cyan(displayName)} ${chalk.dim(`(${skill.source})`)}`);
      if (skill.description) {
        lines.push(`    ${chalk.dim(skill.description)}`);
      }
    }
    return lines.join("\n");
  }

  if (args[0] === "info") {
    const name = args[1];
    if (!name) {
      return chalk.yellow("Usage: /skills info <name>");
    }
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return chalk.yellow(`Skill not found: ${name}`);
    }
    const lines = [
      chalk.bold(skill.name) + chalk.dim(` (${skill.source})`),
      skill.description ? chalk.dim(skill.description) : "",
      chalk.dim(`File: ${skill.filePath}`),
      chalk.dim(`Content: ${skill.content.length} characters`),
    ];

    // Show requirements
    if (skill.requires) {
      if (skill.requires.bins && skill.requires.bins.length > 0) {
        lines.push(chalk.dim(`Requires binaries: ${skill.requires.bins.join(", ")}`));
      }
      if (skill.requires.os && skill.requires.os.length > 0) {
        lines.push(chalk.dim(`Requires OS: ${skill.requires.os.join(", ")}`));
      }
    }

    // Show install instructions
    if (skill.install && skill.install.length > 0) {
      lines.push("");
      lines.push(chalk.bold("Installation:"));
      for (const cmd of skill.install) {
        lines.push(`  ${chalk.dim(cmd)}`);
      }
    }

    lines.push("");
    lines.push(skill.content);

    return lines.filter(Boolean).join("\n");
  }

  return chalk.yellow("Usage: /skills  |  /skills info <name>");
}

async function cmdMemory(ctx: CommandContext, args: string[]): Promise<string> {
  const subCmd = args[0];

  if (!subCmd) {
    return chalk.dim("Usage: /memory search <query>  |  /memory add <file>");
  }

  if (subCmd === "search") {
    const queryText = args.slice(1).join(" ");
    if (!queryText) {
      return chalk.yellow("Usage: /memory search <query>");
    }

    try {
      const { generateEmbedding } = await import("../memory/embeddings.ts");
      const { hybridSearch } = await import("../memory/search.ts");

      const embedding = await generateEmbedding(queryText);
      const results = await hybridSearch(queryText, embedding, 5);

      if (results.length === 0) {
        return chalk.dim("No results found.");
      }

      const lines: string[] = [];
      for (const result of results) {
        lines.push(
          chalk.bold(result.path ?? result.source) +
            chalk.dim(` (score: ${result.score.toFixed(4)})`),
        );
        const preview = result.text.slice(0, 200).replace(/\n/g, " ");
        lines.push(chalk.dim(`  ${preview}${result.text.length > 200 ? "..." : ""}`));
        lines.push("");
      }
      return lines.join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Memory search failed: ${message}`);
    }
  }

  if (subCmd === "add") {
    const filePath = args[1];
    if (!filePath) {
      return chalk.yellow("Usage: /memory add <file>");
    }

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const crypto = await import("node:crypto");
      const { chunkText } = await import("../memory/chunker.ts");
      const { generateEmbeddings } = await import("../memory/embeddings.ts");
      const { storeMemoryChunk } = await import("../db/memory.ts");

      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return chalk.red(`File not found: ${resolved}`);
      }

      const content = fs.readFileSync(resolved, "utf-8");
      const chunks = chunkText(content);
      if (chunks.length === 0) {
        return chalk.dim("No content to index.");
      }

      const texts = chunks.map((c) => c.text);
      const embeddings = await generateEmbeddings(texts);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const hash = crypto.createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
        const id = `${path.relative(process.cwd(), resolved)}:${chunk.startLine}-${chunk.endLine}`;

        await storeMemoryChunk({
          id,
          source: "inline",
          path: resolved,
          text: chunk.text,
          embedding: embeddings[i],
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash,
          model: ctx.config.embeddingModel,
        });
      }

      return chalk.dim(`Added ${chunks.length} chunk(s) from ${path.basename(resolved)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Memory add failed: ${message}`);
    }
  }

  return chalk.yellow(`Unknown memory subcommand: ${subCmd}`);
}

async function cmdConfig(args: string[]): Promise<string> {
  const subCmd = args[0];

  if (!subCmd) {
    const entries = await listConfig();
    if (entries.length === 0) {
      return chalk.dim("No config values stored.");
    }
    const lines: string[] = [];
    for (const entry of entries) {
      lines.push(chalk.bold(entry.key) + chalk.dim(` = ${JSON.stringify(entry.value)}`));
    }
    return lines.join("\n");
  }

  if (subCmd === "set") {
    const key = args[1];
    const rawValue = args.slice(2).join(" ");
    if (!key || !rawValue) {
      return chalk.yellow("Usage: /config set <key> <value>");
    }
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    await setConfigValue(key, value);
    return chalk.dim(`Set ${key} = ${JSON.stringify(value)}`);
  }

  if (subCmd === "get") {
    const key = args[1];
    if (!key) {
      return chalk.yellow("Usage: /config get <key>");
    }
    const value = await getConfigValue(key);
    if (value === null) {
      return chalk.dim(`${key} is not set`);
    }
    return chalk.dim(`${key} = ${JSON.stringify(value)}`);
  }

  return chalk.yellow("Usage: /config  |  /config set <key> <value>  |  /config get <key>");
}

function cmdTools(ctx: CommandContext): string {
  const lines = [
    chalk.bold("Tools:"),
    chalk.dim(
      "  All Claude Code built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, etc.)",
    ),
  ];

  const mcpNames = Object.keys(ctx.mcpServers);
  if (mcpNames.length > 0) {
    lines.push(chalk.bold(`\nMCP Servers (${mcpNames.length}):`));
    for (const name of mcpNames) {
      const config = ctx.mcpServers[name];
      const type = "type" in config ? config.type : "stdio";
      lines.push(`  ${chalk.cyan(name)} ${chalk.dim(`(${type})`)}`);
    }
  }

  return lines.join("\n");
}

async function cmdCost(ctx: CommandContext): Promise<string> {
  const row = await getSession(ctx.session.id);
  if (!row?.token_usage) {
    return chalk.dim("No usage data recorded yet.");
  }

  const { input, output } = row.token_usage;
  const total = input + output;

  const lines = [
    chalk.bold("Session token usage:"),
    chalk.dim(`  Input:  ${input.toLocaleString()} tokens`),
    chalk.dim(`  Output: ${output.toLocaleString()} tokens`),
    chalk.dim(`  Total:  ${total.toLocaleString()} tokens`),
  ];
  return lines.join("\n");
}

function cmdHistory(ctx: CommandContext): string {
  if (ctx.transcript.length === 0) {
    return chalk.dim("No messages in conversation.");
  }

  const lines = [chalk.bold(`Conversation (${ctx.transcript.length} messages):`)];

  for (let i = 0; i < ctx.transcript.length; i++) {
    const msg = ctx.transcript[i];
    const role = msg.role === "user" ? chalk.green("You") : chalk.blue("Nomos");
    const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
    const truncated = msg.content.length > 120 ? "..." : "";
    lines.push(`  ${chalk.dim(`${i + 1}.`)} ${role}: ${preview}${truncated}`);
  }

  return lines.join("\n");
}

async function cmdUndo(ctx: CommandContext): Promise<string> {
  if (ctx.transcript.length < 2) {
    return chalk.dim("Nothing to undo.");
  }

  const last = ctx.transcript[ctx.transcript.length - 1];
  const secondLast = ctx.transcript[ctx.transcript.length - 2];

  let removeCount = 0;
  if (last.role === "assistant" && secondLast.role === "user") {
    ctx.transcript.pop();
    ctx.transcript.pop();
    removeCount = 2;
  } else if (last.role === "user") {
    ctx.transcript.pop();
    removeCount = 1;
  } else {
    ctx.transcript.pop();
    removeCount = 1;
  }

  await deleteLastTranscriptMessages(ctx.session.id, removeCount);
  return chalk.dim(`Removed last ${removeCount} message(s). ${ctx.transcript.length} remaining.`);
}

async function cmdCopy(ctx: CommandContext): Promise<string> {
  // Find the last assistant message
  const lastAssistant = [...ctx.transcript].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) {
    return chalk.dim("No assistant response to copy.");
  }

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Use platform-specific clipboard command
    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === "darwin") {
      cmd = "pbcopy";
      args = [];
    } else if (platform === "linux") {
      // Try xclip first, fall back to xsel
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    } else if (platform === "win32") {
      cmd = "clip";
      args = [];
    } else {
      return chalk.yellow("Clipboard not supported on this platform.");
    }

    const child = execFileAsync(cmd, args, { timeout: 5000 });
    child.child.stdin?.write(lastAssistant.content);
    child.child.stdin?.end();
    await child;

    const preview = lastAssistant.content.slice(0, 60).replace(/\n/g, " ");
    const truncated = lastAssistant.content.length > 60 ? "..." : "";
    return chalk.dim(`Copied to clipboard: "${preview}${truncated}"`);
  } catch {
    return chalk.red("Failed to copy to clipboard. Ensure pbcopy/xclip/clip is available.");
  }
}

async function cmdMcp(ctx: CommandContext): Promise<string> {
  const mcpNames = Object.keys(ctx.mcpServers);
  const lines: string[] = [];

  if (mcpNames.length === 0) {
    lines.push(chalk.dim("No MCP servers configured."));
  } else {
    lines.push(chalk.bold(`MCP servers (${mcpNames.length}):`));
    for (const name of mcpNames) {
      const config = ctx.mcpServers[name];
      const type = "type" in config ? (config.type ?? "stdio") : "stdio";
      lines.push(`  ${chalk.cyan(name)} ${chalk.dim(`(${type})`)}`);
    }
  }

  const mcpConfig = await loadMcpConfig();
  if (mcpConfig) {
    const available = Object.keys(mcpConfig).filter((n) => !mcpNames.includes(n));
    if (available.length > 0) {
      lines.push(chalk.dim(`\nAvailable (not loaded): ${available.join(", ")}`));
    }
  }

  return lines.join("\n");
}

function cmdCompact(ctx: CommandContext): CommandResult {
  const msgCount = ctx.transcript.length;
  ctx.transcript.length = 0;
  return {
    output: chalk.dim(`Compacted ${msgCount} messages. Context cleared for fresh start.`),
    compact: true,
  };
}

async function cmdStatus(ctx: CommandContext): Promise<string> {
  const row = await getSession(ctx.session.id);
  const profile = await loadUserProfile();
  const identity = await loadAgentIdentity();
  const skills = loadSkills();
  const mcpNames = Object.keys(ctx.mcpServers);

  const lines = [
    chalk.bold("Status"),
    `  Model:    ${chalk.cyan(ctx.state.model)}`,
    `  Thinking: ${chalk.cyan(ctx.state.thinkingLevel ?? "high")}`,
    `  Sandbox:  ${ctx.state.sandboxEnabled ? chalk.green("enabled") : chalk.red("disabled")}`,
    `  Session:  ${chalk.dim(ctx.session.session_key)}`,
    `  Messages: ${ctx.transcript.length} in memory`,
  ];

  if (row?.token_usage) {
    const { input, output } = row.token_usage;
    const fmtIn = input >= 1000 ? `${(input / 1000).toFixed(1)}K` : String(input);
    const fmtOut = output >= 1000 ? `${(output / 1000).toFixed(1)}K` : String(output);
    lines.push(`  Usage:    ${fmtIn} in / ${fmtOut} out`);
  }

  lines.push(`  Skills:   ${skills.length} loaded`);
  lines.push(`  MCP:      ${mcpNames.length} server(s)`);

  const profileName = profile.name ?? "(not set)";
  const identityName = identity.name;
  lines.push(`  Profile:  ${profileName}`);
  if (identityName !== "Nomos") {
    lines.push(`  Agent:    ${identityName}${identity.emoji ? ` ${identity.emoji}` : ""}`);
  }

  return lines.join("\n");
}

function cmdContext(ctx: CommandContext): string {
  if (ctx.transcript.length === 0) {
    return chalk.dim("No messages in context.");
  }

  // Rough token estimate: ~4 chars per token for English text
  const totalChars = ctx.transcript.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = Math.round(totalChars / 4);
  const fmtTokens =
    estimatedTokens >= 1000 ? `${(estimatedTokens / 1000).toFixed(1)}K` : String(estimatedTokens);

  const lines = [
    chalk.bold("Context"),
    `  Messages:     ${ctx.transcript.length}`,
    `  Est. tokens:  ~${fmtTokens} (rough estimate)`,
    chalk.dim("\n  Use /compact to reduce context usage."),
  ];
  return lines.join("\n");
}

async function cmdAgent(ctx: CommandContext, args: string[]): Promise<string> {
  const agents = loadAgentConfigs();
  const subCmd = args[0];

  if (!subCmd || subCmd === "list") {
    const lines = [chalk.bold(`Agents (${agents.length}):`)];
    for (const agent of agents) {
      const current =
        agent.id === (ctx.state.activeAgentId ?? "default") ? chalk.green(" ← active") : "";
      lines.push(`  ${chalk.cyan(agent.id)} ${chalk.dim(agent.name)}${current}`);
      if (agent.model) lines.push(`    ${chalk.dim(`model: ${agent.model}`)}`);
    }
    lines.push("", chalk.dim("Use /agent <id> to switch."));
    return lines.join("\n");
  }

  // Switch agent
  const target = getActiveAgent(agents, subCmd);
  if (target.id === "default" && subCmd !== "default") {
    return chalk.yellow(`Agent not found: ${subCmd}. Use /agent list to see available.`);
  }
  ctx.state.activeAgentId = target.id;
  if (target.model) ctx.state.model = target.model;
  if (target.thinkingLevel)
    ctx.state.thinkingLevel = target.thinkingLevel as CommandState["thinkingLevel"];
  return chalk.dim(`Switched to agent: ${target.name} (${target.id})`);
}

async function cmdSlackWorkspaces(): Promise<string> {
  try {
    const { listWorkspaces } = await import("../db/slack-workspaces.ts");
    const workspaces = await listWorkspaces();

    if (workspaces.length === 0) {
      return chalk.dim('No Slack workspaces connected. Run "nomos slack auth" to connect one.');
    }

    const lines = [chalk.bold(`Connected Slack workspaces (${workspaces.length}):`)];
    for (const ws of workspaces) {
      const date =
        ws.created_at instanceof Date ? ws.created_at.toLocaleDateString() : String(ws.created_at);
      lines.push(`  ${chalk.cyan(ws.team_name)} ${chalk.dim(`(${ws.team_id})`)}`);
      lines.push(`    ${chalk.dim(`User: ${ws.user_id}  Connected: ${date}`)}`);
    }
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return chalk.red(`Failed to list workspaces: ${message}`);
  }
}

async function cmdDrafts(): Promise<string> {
  try {
    const { listPendingDrafts } = await import("../db/drafts.ts");
    const drafts = await listPendingDrafts();

    if (drafts.length === 0) {
      return chalk.dim("No pending drafts.");
    }

    const lines = [chalk.bold(`Pending drafts (${drafts.length}):`)];
    for (const draft of drafts) {
      const shortId = draft.id.slice(0, 8);
      const ctx = draft.context as Record<string, unknown>;
      const contextLabel =
        ctx.messageType === "dm"
          ? `DM from ${ctx.senderName ?? "unknown"}`
          : ctx.channelName
            ? `#${ctx.channelName}`
            : draft.channel_id;
      const preview = draft.content.slice(0, 80).replace(/\n/g, " ");
      const age = Math.round((Date.now() - new Date(draft.created_at).getTime()) / 60_000);
      const ageFmt = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;

      lines.push(`  ${chalk.cyan(shortId)} ${chalk.dim(`[${contextLabel}]`)} ${chalk.dim(ageFmt)}`);
      lines.push(`    ${preview}${draft.content.length > 80 ? "..." : ""}`);
    }

    lines.push("", chalk.dim("Use /approve <id> or /reject <id>"));
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return chalk.red(`Failed to list drafts: ${message}`);
  }
}

async function cmdApproveDraft(args: string[]): Promise<string> {
  const prefix = args[0];
  if (!prefix) {
    return chalk.yellow("Usage: /approve <draft-id>");
  }

  try {
    const { getDraftByPrefix, approveDraft, markDraftSent } = await import("../db/drafts.ts");
    const draft = await getDraftByPrefix(prefix);
    if (!draft) {
      return chalk.yellow(`No pending draft found matching "${prefix}"`);
    }
    if (draft.status !== "pending") {
      return chalk.yellow(`Draft ${draft.id.slice(0, 8)} is already ${draft.status}`);
    }

    // Approve the draft
    const approved = await approveDraft(draft.id);
    if (!approved) {
      return chalk.red("Failed to approve draft (may have been processed already)");
    }

    // Send as user
    try {
      const { getWorkspaceByPlatform } = await import("../db/slack-workspaces.ts");
      const ws = await getWorkspaceByPlatform(draft.platform);
      const userToken = ws?.access_token ?? process.env.SLACK_USER_TOKEN;
      if (!userToken) {
        return chalk.red("No Slack user token found for this workspace");
      }
      const { WebClient } = await import("@slack/web-api");
      const client = new WebClient(userToken);
      await client.chat.postMessage({
        channel: draft.channel_id,
        text: draft.content,
        thread_ts: draft.thread_id ?? undefined,
      });
      await markDraftSent(draft.id);
      return chalk.dim(`Draft ${draft.id.slice(0, 8)} approved and sent`);
    } catch (sendErr) {
      const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
      return chalk.red(`Draft approved but send failed: ${message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return chalk.red(`Failed to approve draft: ${message}`);
  }
}

async function cmdRejectDraft(args: string[]): Promise<string> {
  const prefix = args[0];
  if (!prefix) {
    return chalk.yellow("Usage: /reject <draft-id>");
  }

  try {
    const { getDraftByPrefix, rejectDraft } = await import("../db/drafts.ts");
    const draft = await getDraftByPrefix(prefix);
    if (!draft) {
      return chalk.yellow(`No pending draft found matching "${prefix}"`);
    }
    if (draft.status !== "pending") {
      return chalk.yellow(`Draft ${draft.id.slice(0, 8)} is already ${draft.status}`);
    }

    const rejected = await rejectDraft(draft.id);
    if (!rejected) {
      return chalk.red("Failed to reject draft (may have been processed already)");
    }

    return chalk.dim(`Draft ${draft.id.slice(0, 8)} rejected`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return chalk.red(`Failed to reject draft: ${message}`);
  }
}

async function cmdPermissions(args: string[]): Promise<string> {
  const subCmd = args[0];

  if (!subCmd) {
    // List all permissions
    try {
      const { listPermissions } = await import("../db/permissions.ts");
      const perms = await listPermissions();

      if (perms.length === 0) {
        return chalk.dim(
          "No stored permissions.\nThe agent will ask before sensitive operations.\n\n" +
            "Usage:\n" +
            "  /permissions grant <type> <action> <pattern>\n" +
            "  /permissions revoke <type> <action> <pattern>\n" +
            "  /permissions clear",
        );
      }

      const lines = [chalk.bold(`Permissions (${perms.length}):`)];
      for (const p of perms) {
        const grantedBy = p.granted_by ? chalk.dim(` (by ${p.granted_by})`) : "";
        lines.push(
          `  ${chalk.cyan(p.resource_type)}/${chalk.cyan(p.action)} → ${p.pattern}${grantedBy}`,
        );
      }
      lines.push("", chalk.dim("Use /permissions revoke <type> <action> <pattern> to remove."));
      return lines.join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Failed to list permissions: ${message}`);
    }
  }

  if (subCmd === "grant") {
    const [, resourceType, action, ...patternParts] = args;
    const pattern = patternParts.join(" ");

    if (!resourceType || !action || !pattern) {
      return chalk.yellow(
        "Usage: /permissions grant <type> <action> <pattern>\n" +
          "  Types: path, command, package\n" +
          "  Actions: read, write, execute, install\n" +
          "  Example: /permissions grant path read /Users/me/Documents/*",
      );
    }

    try {
      const { grantPermission } = await import("../db/permissions.ts");
      await grantPermission(resourceType, action, pattern);
      return chalk.dim(`Permission granted: ${resourceType}/${action} → ${pattern}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Failed to grant permission: ${message}`);
    }
  }

  if (subCmd === "revoke") {
    const [, resourceType, action, ...patternParts] = args;
    const pattern = patternParts.join(" ");

    if (!resourceType || !action || !pattern) {
      return chalk.yellow("Usage: /permissions revoke <type> <action> <pattern>");
    }

    try {
      const { revokePermission } = await import("../db/permissions.ts");
      const removed = await revokePermission(resourceType, action, pattern);
      return removed
        ? chalk.dim(`Permission revoked: ${resourceType}/${action} → ${pattern}`)
        : chalk.yellow(`No matching permission found.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Failed to revoke permission: ${message}`);
    }
  }

  if (subCmd === "clear") {
    try {
      const { clearAllPermissions } = await import("../db/permissions.ts");
      const count = await clearAllPermissions();
      return chalk.dim(`Cleared ${count} permission(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chalk.red(`Failed to clear permissions: ${message}`);
    }
  }

  return chalk.yellow(
    "Usage: /permissions  |  /permissions grant <type> <action> <pattern>  |  /permissions revoke <type> <action> <pattern>  |  /permissions clear",
  );
}

async function cmdIntegrations(ctx: CommandContext, args: string[]): Promise<string> {
  const subCmd = args[0];

  if (subCmd === "google") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const execFileAsync = promisify(execFile);

    // Check gws availability
    try {
      const { stdout } = await execFileAsync("npx", ["gws", "--version"], { timeout: 10000 });
      const version = stdout.trim();

      // Check for existing auth
      const { stdout: authOut } = await execFileAsync("npx", ["gws", "auth", "list"], {
        timeout: 10000,
      });
      const authData = JSON.parse(authOut);

      if (authData.count > 0) {
        const accounts = (authData.accounts ?? []).join(", ");
        return [
          chalk.bold("Google Workspace"),
          chalk.dim(`  gws: ${version}`),
          chalk.dim(`  Accounts: ${accounts}`),
          chalk.dim(`  Default: ${authData.default || "(none)"}`),
          "",
          chalk.dim("Already configured. Use settings UI to modify."),
        ].join("\n");
      }

      // Check if client_secret.json exists
      const gwsConfigDir = path.join(os.homedir(), ".config", "gws");
      const clientSecretPath = path.join(gwsConfigDir, "client_secret.json");

      if (!fs.existsSync(clientSecretPath)) {
        return [
          chalk.bold("Google Workspace Setup"),
          chalk.dim(`  gws: ${version}`),
          "",
          chalk.yellow("No client_secret.json found at ~/.config/gws/"),
          "",
          chalk.dim("Setup options:"),
          chalk.dim("  1. Run: gws auth setup (requires gcloud CLI)"),
          chalk.dim("  2. Use the Settings UI at /integrations/google"),
          chalk.dim(
            "  3. Manually create a GCP OAuth client and place client_secret.json in ~/.config/gws/",
          ),
          "",
          chalk.dim("After setting up credentials, run: gws auth login"),
        ].join("\n");
      }

      // Has client_secret.json but no accounts — run login
      return [
        chalk.bold("Google Workspace Setup"),
        chalk.dim(`  gws: ${version}`),
        chalk.dim("  Credentials: found"),
        "",
        chalk.dim("Run `gws auth login` to authorize your Google account."),
        chalk.dim("This will open a browser window for OAuth authorization."),
      ].join("\n");
    } catch {
      return chalk.red(
        "gws CLI not available. Ensure @googleworkspace/cli is installed (pnpm add @googleworkspace/cli).",
      );
    }
  }

  // No args: show overview
  const lines = [chalk.bold("Integrations")];

  // Google
  try {
    const { isGoogleWorkspaceConfigured } = await import("../sdk/google-workspace-mcp.ts");
    const configured = isGoogleWorkspaceConfigured();
    lines.push(
      `  ${chalk.cyan("google")}  ${configured ? chalk.green("configured") : chalk.dim("not configured")}`,
    );
  } catch {
    lines.push(`  ${chalk.cyan("google")}  ${chalk.dim("not configured")}`);
  }

  // Slack
  const slackConfigured = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
  lines.push(
    `  ${chalk.cyan("slack")}   ${slackConfigured ? chalk.green("configured") : chalk.dim("not configured")}`,
  );

  // Discord
  const discordConfigured = !!process.env.DISCORD_BOT_TOKEN;
  lines.push(
    `  ${chalk.cyan("discord")} ${discordConfigured ? chalk.green("configured") : chalk.dim("not configured")}`,
  );

  // Telegram
  const telegramConfigured = !!process.env.TELEGRAM_BOT_TOKEN;
  lines.push(
    `  ${chalk.cyan("telegram")} ${telegramConfigured ? chalk.green("configured") : chalk.dim("not configured")}`,
  );

  lines.push("", chalk.dim("Use /integrations <name> for setup. E.g. /integrations google"));

  return lines.join("\n");
}

function cmdTeam(args: string[], rawInput: string): CommandResult {
  const task = args.join(" ");
  if (!task) {
    return {
      output: [
        chalk.bold("Team Mode"),
        chalk.dim("  Spawn parallel agent workers to decompose and execute complex tasks."),
        "",
        chalk.dim("Usage: /team <task description>"),
        chalk.dim("  Example: /team analyze Q4 metrics, refactor auth module, update docs"),
        "",
        chalk.dim("Requires NOMOS_TEAM_MODE=true in your environment."),
      ].join("\n"),
    };
  }
  // Pass the full /team message through to the agent
  return { output: "", passthrough: rawInput };
}

function cmdUndoFiles(): string {
  return chalk.dim(
    "File undo requires V2 SDK (coming soon). Use git to revert changes.\n  git checkout -- <file>  or  git stash",
  );
}
