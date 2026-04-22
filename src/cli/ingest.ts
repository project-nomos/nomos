/**
 * CLI command: nomos ingest
 *
 * Ingests historical messages from communication platforms.
 *
 * Usage:
 *   nomos ingest slack [--since DATE] [--dry-run]
 *   nomos ingest imessage [--since DATE] [--contact NAME] [--dry-run]
 *   nomos ingest gmail [--since DATE] [--contact NAME] [--dry-run]
 *   nomos ingest discord [--since DATE] [--dry-run]
 *   nomos ingest telegram [--since DATE] [--dry-run]
 *   nomos ingest whatsapp <file> --user-name NAME [--since DATE] [--dry-run]
 *   nomos ingest status
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDb, closeDb } from "../db/client.ts";
import {
  runIngestionPipeline,
  listIngestJobs,
  createSlackIngestSources,
  IMessageIngestSource,
  GmailIngestSource,
  WhatsAppIngestSource,
  DiscordIngestSource,
  TelegramIngestSource,
} from "../ingest/index.ts";
import type { IngestSource, IngestOptions } from "../ingest/types.ts";

export function registerIngestCommand(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Ingest historical messages from communication platforms");

  // nomos ingest slack
  ingest
    .command("slack")
    .description("Ingest sent messages from all Slack workspaces")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--run-type <type>", "Run type: full or delta", "full")
    .option("--dry-run", "Count messages without storing")
    .action(async (opts) => {
      getDb();
      try {
        const sources = await createSlackIngestSources();
        if (sources.length === 0) {
          console.log(chalk.yellow("No Slack workspaces configured. Add one in Settings first."));
          return;
        }

        for (const source of sources) {
          console.log(chalk.blue(`\nIngesting from ${source.platform}...`));
          await runSource(source, opts);
        }
      } finally {
        await closeDb();
      }
    });

  // nomos ingest imessage
  ingest
    .command("imessage")
    .description("Ingest messages from iMessage (macOS only)")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--run-type <type>", "Run type: full or delta", "full")
    .option("--contact <name>", "Filter to specific contact")
    .option("--dry-run", "Count messages without storing")
    .option("--db-path <path>", "Custom path to chat.db")
    .action(async (opts) => {
      getDb();
      try {
        const source = new IMessageIngestSource(opts.dbPath);
        console.log(chalk.blue("Ingesting from iMessage..."));
        await runSource(source, opts);
      } finally {
        await closeDb();
      }
    });

  // nomos ingest gmail
  ingest
    .command("gmail")
    .description("Ingest sent emails from Gmail")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--run-type <type>", "Run type: full or delta", "full")
    .option("--contact <email>", "Filter to specific contact")
    .option("--dry-run", "Count messages without storing")
    .action(async (opts) => {
      getDb();
      try {
        const source = new GmailIngestSource();
        console.log(chalk.blue("Ingesting from Gmail (sent folder)..."));
        await runSource(source, opts);
      } finally {
        await closeDb();
      }
    });

  // nomos ingest discord
  ingest
    .command("discord")
    .description("Ingest sent messages from Discord")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--run-type <type>", "Run type: full or delta", "full")
    .option("--dry-run", "Count messages without storing")
    .action(async (opts) => {
      getDb();
      try {
        const source = new DiscordIngestSource();
        console.log(chalk.blue("Ingesting from Discord..."));
        await runSource(source, opts);
      } finally {
        await closeDb();
      }
    });

  // nomos ingest telegram
  ingest
    .command("telegram")
    .description("Ingest sent messages from Telegram")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--run-type <type>", "Run type: full or delta", "full")
    .option("--dry-run", "Count messages without storing")
    .action(async (opts) => {
      getDb();
      try {
        const source = new TelegramIngestSource();
        console.log(chalk.blue("Ingesting from Telegram..."));
        await runSource(source, opts);
      } finally {
        await closeDb();
      }
    });

  // nomos ingest whatsapp
  ingest
    .command("whatsapp <file>")
    .description("Ingest from a WhatsApp .txt export file")
    .requiredOption("--user-name <name>", "Your display name in the export")
    .option("--since <date>", "Only ingest messages after this date")
    .option("--dry-run", "Count messages without storing")
    .action(async (file: string, opts) => {
      getDb();
      try {
        const source = new WhatsAppIngestSource(file, opts.userName);
        console.log(chalk.blue(`Ingesting from WhatsApp export: ${file}...`));
        await runSource(source, opts);
      } finally {
        await closeDb();
      }
    });

  // nomos ingest status
  ingest
    .command("status")
    .description("Show ingestion job status")
    .action(async () => {
      getDb();
      try {
        const jobs = await listIngestJobs();

        if (jobs.length === 0) {
          console.log(chalk.dim("No ingestion jobs found."));
          return;
        }

        console.log(chalk.bold("\nIngestion Jobs\n"));
        for (const job of jobs) {
          const statusColor =
            job.status === "completed"
              ? chalk.green
              : job.status === "running"
                ? chalk.blue
                : job.status === "failed"
                  ? chalk.red
                  : chalk.dim;

          const runLabel = job.run_type === "delta" ? chalk.cyan("[delta]") : chalk.dim("[full]");
          console.log(
            `  ${chalk.bold(job.platform)} (${job.source_type}) ` +
              statusColor(`[${job.status}]`) +
              ` ${runLabel}`,
          );
          console.log(
            `    Messages: ${job.messages_processed} processed, ${job.messages_skipped} skipped`,
          );
          if (job.started_at) {
            console.log(`    Started:  ${new Date(job.started_at).toLocaleString()}`);
          }
          if (job.finished_at) {
            console.log(`    Finished: ${new Date(job.finished_at).toLocaleString()}`);
          }
          if (job.delta_enabled) {
            console.log(`    Delta:    every ${job.delta_schedule}`);
          }
          if (job.error) {
            console.log(`    Error:    ${chalk.red(job.error)}`);
          }
          console.log();
        }
      } finally {
        await closeDb();
      }
    });
}

async function runSource(
  source: IngestSource,
  opts: { since?: string; contact?: string; dryRun?: boolean; runType?: string },
): Promise<void> {
  const options: IngestOptions = {
    since: opts.since ? new Date(opts.since) : undefined,
    contact: opts.contact,
    dryRun: opts.dryRun,
    runType: (opts.runType as "full" | "delta") ?? "full",
  };

  if (opts.dryRun) {
    console.log(chalk.dim("  (dry run — no data will be stored)\n"));
  }

  const startTime = Date.now();
  let lastUpdate = 0;

  const progress = await runIngestionPipeline(source, options, {
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastUpdate > 2000) {
        process.stdout.write(
          `\r  ${chalk.dim("Processing...")} ${p.messagesProcessed} processed, ${p.messagesSkipped} skipped`,
        );
        lastUpdate = now;
      }
    },
    onError: (err) => {
      console.error(chalk.red(`\n  Error: ${err.message}`));
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n\n  ${chalk.green("Done!")} ${progress.messagesProcessed} messages processed, ` +
      `${progress.messagesSkipped} skipped (${elapsed}s)`,
  );

  if (progress.error) {
    console.log(chalk.red(`  Error: ${progress.error}`));
  }
}
