import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations, createCustomerSchema, dropCustomerSchema } from "../db/migrate.ts";
import { closeDb } from "../db/client.ts";

export function registerDbCommand(program: Command): void {
  const cmd = program.command("db").description("Database management");

  cmd
    .command("migrate")
    .description("Run database migrations")
    .option("--schema <name>", "Apply to a specific Postgres schema (e.g., nomos_abc123)")
    .action(async (opts: { schema?: string }) => {
      try {
        await runMigrations(opts.schema ?? null);
        console.log(
          chalk.green(
            `Database migrations complete${opts.schema ? ` (schema: ${opts.schema})` : ""}`,
          ),
        );
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
    .command("create-schema <name>")
    .description("Create a new per-customer Postgres schema (nomos_<id>)")
    .action(async (name: string) => {
      try {
        await createCustomerSchema(name);
        console.log(chalk.green(`Created schema: ${name}`));
      } catch (error) {
        console.error(
          chalk.red("Create schema failed:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("drop-schema <name>")
    .description("Drop a per-customer Postgres schema and ALL its data (destructive)")
    .action(async (name: string) => {
      try {
        await dropCustomerSchema(name);
        console.log(chalk.yellow(`Dropped schema: ${name}`));
      } catch (error) {
        console.error(
          chalk.red("Drop schema failed:"),
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      } finally {
        await closeDb();
      }
    });
}
