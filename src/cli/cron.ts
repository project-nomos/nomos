import type { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import { runMigrations } from "../db/migrate.ts";
import { getDb, closeDb } from "../db/client.ts";
import { CronStore } from "../cron/store.ts";

export function registerCronCommand(program: Command): void {
  const cmd = program.command("cron").description("Manage autonomous cron jobs");

  cmd
    .command("list")
    .description("List all cron jobs")
    .action(async () => {
      try {
        await runMigrations();
        const store = new CronStore(getDb());
        const jobs = await store.listJobs();

        if (jobs.length === 0) {
          console.log(chalk.dim("No cron jobs found"));
          return;
        }

        console.log(chalk.bold("\nCron Jobs:\n"));
        console.log(
          chalk.dim(
            "  " +
              "Name".padEnd(24) +
              "Schedule".padEnd(20) +
              "Status".padEnd(12) +
              "Last Run".padEnd(22) +
              "Errors",
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(86)));

        for (const job of jobs) {
          const status = job.enabled ? chalk.green("enabled") : chalk.yellow("disabled");
          const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString() : chalk.dim("never");
          const errors = job.errorCount > 0 ? chalk.red(String(job.errorCount)) : chalk.dim("0");

          console.log(
            `  ${chalk.cyan(job.name.padEnd(24))}${job.schedule.padEnd(20)}${status.padEnd(21)}${String(lastRun).padEnd(22)}${errors}`,
          );
        }
        console.log();
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("enable <name>")
    .description("Enable a cron job by name")
    .action(async (name: string) => {
      try {
        await runMigrations();
        const store = new CronStore(getDb());
        const job = await store.getJobByName(name);

        if (!job) {
          console.error(chalk.red(`No cron job found with name: ${name}`));
          process.exit(1);
        }

        if (job.enabled) {
          console.log(chalk.yellow(`Job "${name}" is already enabled`));
          return;
        }

        await store.updateJob(job.id, { enabled: true });
        console.log(chalk.green(`Enabled cron job: ${name}`));
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("disable <name>")
    .description("Disable a cron job by name")
    .action(async (name: string) => {
      try {
        await runMigrations();
        const store = new CronStore(getDb());
        const job = await store.getJobByName(name);

        if (!job) {
          console.error(chalk.red(`No cron job found with name: ${name}`));
          process.exit(1);
        }

        if (!job.enabled) {
          console.log(chalk.yellow(`Job "${name}" is already disabled`));
          return;
        }

        await store.updateJob(job.id, { enabled: false });
        console.log(chalk.green(`Disabled cron job: ${name}`));
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("delete <name>")
    .description("Delete a cron job by name")
    .action(async (name: string) => {
      try {
        await runMigrations();
        const store = new CronStore(getDb());
        const job = await store.getJobByName(name);

        if (!job) {
          console.error(chalk.red(`No cron job found with name: ${name}`));
          process.exit(1);
        }

        await store.deleteJob(job.id);
        console.log(chalk.green(`Deleted cron job: ${name}`));
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("create <name> <schedule>")
    .description("Create a new cron job")
    .option("--prompt <text>", "Prompt text for the job")
    .option("--file <path>", "Read prompt from a file")
    .action(async (name: string, schedule: string, options: { prompt?: string; file?: string }) => {
      try {
        if (!options.prompt && !options.file) {
          console.error(chalk.red("Must specify either --prompt or --file"));
          process.exit(1);
        }

        let prompt: string;
        if (options.file) {
          try {
            prompt = fs.readFileSync(options.file, "utf-8").trim();
          } catch {
            console.error(chalk.red(`Could not read file: ${options.file}`));
            process.exit(1);
          }
        } else {
          prompt = options.prompt!;
        }

        await runMigrations();
        const store = new CronStore(getDb());

        const existing = await store.getJobByName(name);
        if (existing) {
          console.error(chalk.red(`A cron job with name "${name}" already exists`));
          process.exit(1);
        }

        await store.createJob({
          name,
          schedule,
          scheduleType: "cron",
          sessionTarget: "main",
          deliveryMode: "none",
          prompt,
          enabled: false,
          errorCount: 0,
        });

        console.log(chalk.green(`Created cron job: ${name}`));
        console.log(chalk.dim(`  Schedule: ${schedule}`));
        console.log(chalk.dim(`  Status: disabled (use "nomos cron enable ${name}" to activate)`));
      } finally {
        await closeDb();
      }
    });
}
