import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations } from "../db/migrate.ts";
import { getConfigValue, setConfigValue, deleteConfigValue, listConfig } from "../db/config.ts";

export function registerConfigCommand(program: Command): void {
  const cmd = program.command("config").description("Manage nomos configuration");

  cmd
    .command("get <key>")
    .description("Get a config value")
    .action(async (key: string) => {
      await runMigrations();
      const value = await getConfigValue(key);
      if (value === null) {
        console.log(chalk.dim(`(not set)`));
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
    });

  cmd
    .command("set <key> <value>")
    .description("Set a config value (value is parsed as JSON)")
    .action(async (key: string, value: string) => {
      await runMigrations();
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value; // treat as string
      }
      await setConfigValue(key, parsed);
      console.log(chalk.green(`Set ${key}`));
    });

  cmd
    .command("delete <key>")
    .description("Delete a config value")
    .action(async (key: string) => {
      await runMigrations();
      await deleteConfigValue(key);
      console.log(chalk.green(`Deleted ${key}`));
    });

  cmd
    .command("list")
    .description("List all config values")
    .action(async () => {
      await runMigrations();
      const items = await listConfig();
      if (items.length === 0) {
        console.log(chalk.dim("No config values set"));
        return;
      }
      for (const item of items) {
        console.log(`${chalk.bold(item.key)}: ${JSON.stringify(item.value)}`);
      }
    });
}
