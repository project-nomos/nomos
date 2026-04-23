import { Command } from "commander";
import { getInstalledVersion } from "../config/version.ts";
import { registerChatCommand } from "./chat.ts";
import { registerConfigCommand } from "./config.ts";
import { registerSessionCommand } from "./session.ts";
import { registerDbCommand } from "./db.ts";
import { registerMemoryCommand } from "./memory.ts";
import { registerDaemonCommand } from "./daemon.ts";
import { registerSlackCommand } from "./slack.ts";
import { registerCronCommand } from "./cron.ts";
import { registerSettingsCommand } from "./settings.ts";
import { registerServiceCommand } from "./service.ts";
import { registerStatusCommand } from "./status.ts";
import { registerIngestCommand } from "./ingest.ts";
import { registerContactsCommand } from "./contacts.ts";
import { registerPluginCommand } from "./plugin.ts";
import { registerWikiCommand } from "./wiki.ts";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("nomos")
    .description("AI agent powered by Anthropic Claude models")
    .version(getInstalledVersion());

  registerChatCommand(program);
  registerConfigCommand(program);
  registerSessionCommand(program);
  registerDbCommand(program);
  registerMemoryCommand(program);
  registerDaemonCommand(program);
  registerSlackCommand(program);
  registerCronCommand(program);
  registerSettingsCommand(program);
  registerServiceCommand(program);
  registerStatusCommand(program);
  registerIngestCommand(program);
  registerContactsCommand(program);
  registerPluginCommand(program);
  registerWikiCommand(program);

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
