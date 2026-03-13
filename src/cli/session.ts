import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations } from "../db/migrate.ts";
import { listSessions, archiveSession, deleteSession } from "../db/sessions.ts";

export function registerSessionCommand(program: Command): void {
  const cmd = program.command("session").description("Manage chat sessions");

  cmd
    .command("list")
    .description("List recent sessions")
    .option("--status <status>", "Filter by status (active, archived)", "active")
    .option("--limit <n>", "Max sessions to show", parseInt)
    .action(async (options) => {
      await runMigrations();
      const sessions = await listSessions({
        status: options.status,
        limit: options.limit,
      });

      if (sessions.length === 0) {
        console.log(chalk.dim("No sessions found"));
        return;
      }

      console.log(chalk.bold("\nSessions:\n"));
      for (const s of sessions) {
        const usage = s.token_usage;
        const tokens = `${(usage.input + usage.output).toLocaleString()} tokens`;
        const date = new Date(s.updated_at).toLocaleString();
        console.log(
          `  ${chalk.cyan(s.id.slice(0, 8))}  ${chalk.dim(s.session_key)}  ${chalk.dim(date)}  ${chalk.dim(tokens)}  ${s.model ?? "default"}`,
        );
      }
      console.log(chalk.dim(`\nResume with: nomos chat --session <session_key>`));
    });

  cmd
    .command("archive <id>")
    .description("Archive a session")
    .action(async (id: string) => {
      await runMigrations();
      await archiveSession(id);
      console.log(chalk.green(`Archived session ${id}`));
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete a session and its transcript")
    .action(async (id: string) => {
      await runMigrations();
      await deleteSession(id);
      console.log(chalk.green(`Deleted session ${id}`));
    });
}
