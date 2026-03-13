import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations } from "../db/migrate.ts";
import { closeDb } from "../db/client.ts";

export function registerDbCommand(program: Command): void {
  const cmd = program.command("db").description("Database management");

  cmd
    .command("migrate")
    .description("Run database migrations")
    .action(async () => {
      try {
        await runMigrations();
        console.log(chalk.green("Database migrations complete"));
      } catch (error) {
        console.error(
          chalk.red("Migration failed:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      } finally {
        await closeDb();
      }
    });
}
