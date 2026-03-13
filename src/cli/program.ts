import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerChatCommand } from "./chat.ts";
import { registerConfigCommand } from "./config.ts";
import { registerSessionCommand } from "./session.ts";
import { registerDbCommand } from "./db.ts";
import { registerMemoryCommand } from "./memory.ts";
import { registerDaemonCommand } from "./daemon.ts";
import { registerSlackCommand } from "./slack.ts";
import { registerCronCommand } from "./cron.ts";
import { registerSettingsCommand } from "./settings.ts";

function getVersion(): string {
  try {
    // Walk up from this file to find package.json
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "0.0.0";
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("nomos")
    .description("AI agent powered by Anthropic Claude models")
    .version(getVersion());

  registerChatCommand(program);
  registerConfigCommand(program);
  registerSessionCommand(program);
  registerDbCommand(program);
  registerMemoryCommand(program);
  registerDaemonCommand(program);
  registerSlackCommand(program);
  registerCronCommand(program);
  registerSettingsCommand(program);

  // Default command: start daemon (if not running) + chat
  program.action(async () => {
    const { startDaemonIfNeeded } = await import("./start.ts");
    await startDaemonIfNeeded();

    const chatCmd = program.commands.find((c) => c.name() === "chat");
    if (chatCmd) {
      await chatCmd.parseAsync(process.argv);
    }
  });

  return program;
}
