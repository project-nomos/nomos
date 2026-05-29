import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations, createCustomerDatabase, dropCustomerDatabase } from "../db/migrate.ts";
import { closeDb } from "../db/client.ts";

export function registerDbCommand(program: Command): void {
  const cmd = program.command("db").description("Database management");

  cmd
    .command("migrate")
    .description("Run database migrations against the connected database (public schema)")
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

  cmd
    .command("create-database <name>")
    .alias("create-db")
    .description("Create a new per-customer Postgres database (nomos_<id>)")
    .action(async (name: string) => {
      try {
        await createCustomerDatabase(name);
        console.log(chalk.green(`Created database: ${name}`));
      } catch (error) {
        console.error(
          chalk.red("Create database failed:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("drop-database <name>")
    .alias("drop-db")
    .description("Drop a per-customer Postgres database and ALL its data (destructive)")
    .action(async (name: string) => {
      try {
        await dropCustomerDatabase(name);
        console.log(chalk.yellow(`Dropped database: ${name}`));
      } catch (error) {
        console.error(
          chalk.red("Drop database failed:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      } finally {
        await closeDb();
      }
    });
}
