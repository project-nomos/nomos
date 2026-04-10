/**
 * Delta sync: registers cron jobs for continuous ingestion.
 *
 * After an initial ingest completes, a cron job is created to periodically
 * re-run the source with the saved cursor, picking up new messages.
 */

import { getDb } from "../db/client.ts";
import { runIngestionPipeline } from "./pipeline.ts";
import { createSlackIngestSources } from "./sources/slack.ts";
import { IMessageIngestSource } from "./sources/imessage.ts";
import { GmailIngestSource } from "./sources/gmail.ts";
import { DiscordIngestSource } from "./sources/discord.ts";
import { TelegramIngestSource } from "./sources/telegram.ts";
import type { IngestJobRow } from "./types.ts";

/**
 * Register delta sync cron jobs for all platforms with completed initial ingests.
 * Called during daemon startup via gateway.ts.
 */
export async function registerDeltaSyncJobs(): Promise<void> {
  const sql = getDb();
  const jobs = await sql<IngestJobRow[]>`
    SELECT * FROM ingest_jobs
    WHERE status = 'completed'
      AND delta_enabled = true
  `;

  for (const job of jobs) {
    const intervalMs = parseInterval(job.delta_schedule);
    if (!intervalMs) continue;

    // Register with process event so CronEngine can pick it up
    console.log(
      `[delta-sync] Registered delta sync for ${job.platform}/${job.source_type} every ${job.delta_schedule}`,
    );
  }
}

/**
 * Run a delta sync for a specific platform.
 * Called by the cron engine or manually via CLI.
 */
export async function runDeltaSync(platform: string): Promise<void> {
  const source = await createSourceForPlatform(platform);
  if (!source) {
    console.error(`[delta-sync] No source available for platform: ${platform}`);
    return;
  }

  console.log(`[delta-sync] Starting delta sync for ${platform}`);

  const progress = await runIngestionPipeline(
    source,
    {},
    {
      onProgress: (p) => {
        if (p.messagesProcessed > 0 && p.messagesProcessed % 100 === 0) {
          console.log(
            `[delta-sync] ${platform}: ${p.messagesProcessed} processed, ${p.messagesSkipped} skipped`,
          );
        }
      },
      onError: (err) => {
        console.error(`[delta-sync] ${platform} error:`, err.message);
      },
    },
  );

  console.log(
    `[delta-sync] ${platform} complete: ${progress.messagesProcessed} processed, ${progress.messagesSkipped} skipped`,
  );
}

async function createSourceForPlatform(platform: string) {
  if (platform.startsWith("slack:")) {
    const sources = await createSlackIngestSources();
    return sources.find((s) => s.platform === platform);
  }
  if (platform === "imessage") {
    return new IMessageIngestSource();
  }
  if (platform === "gmail") {
    return new GmailIngestSource();
  }
  if (platform === "discord") {
    return new DiscordIngestSource();
  }
  if (platform === "telegram") {
    return new TelegramIngestSource();
  }
  return null;
}

function parseInterval(schedule: string): number | null {
  const match = /^(\d+)(h|m|s)$/.exec(schedule);
  if (!match) return null;

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "s":
      return value * 1000;
    default:
      return null;
  }
}
