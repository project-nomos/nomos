import type postgres from "postgres";
import { CronStore } from "./store.ts";
import { CronScheduler, type CronCallback } from "./scheduler.ts";
import type { CronJob, CronJobUpdate, CronJobFilter } from "./types.ts";

export * from "./types.ts";
export * from "./store.ts";
export * from "./scheduler.ts";

export interface CronSystem {
  store: CronStore;
  scheduler: CronScheduler;
  start: () => void;
  stop: () => void;
  refresh: () => Promise<void>;
}

/**
 * Create a complete cron system with store and scheduler
 */
export function createCronSystem(db: postgres.Sql, onTrigger: CronCallback): CronSystem {
  const store = new CronStore(db);
  let jobs: CronJob[] = [];
  const scheduler = new CronScheduler(jobs, onTrigger);

  return {
    store,
    scheduler,

    start() {
      scheduler.start();
    },

    stop() {
      scheduler.stop();
    },

    async refresh() {
      jobs = await store.listJobs({ enabled: true });
      scheduler.updateJobs(jobs);
    },
  };
}
