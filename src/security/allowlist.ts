import process from "node:process";
import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import type { AllowlistEntry } from "./types.ts";

export class AllowlistStore {
  /**
   * Add a user to the allowlist
   */
  async addUser(platform: string, userId: string, addedBy?: string): Promise<AllowlistEntry> {
    const db = getKysely();

    const row = await db
      .insertInto("channel_allowlists")
      .values({ platform, user_id: userId, added_by: addedBy ?? null })
      .onConflict((oc) =>
        oc.columns(["platform", "user_id"]).doUpdateSet({
          added_by: sql`EXCLUDED.added_by`,
          created_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return row as unknown as AllowlistEntry;
  }

  /**
   * Remove a user from the allowlist
   */
  async removeUser(platform: string, userId: string): Promise<boolean> {
    const db = getKysely();

    const result = await db
      .deleteFrom("channel_allowlists")
      .where("platform", "=", platform)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n) > 0;
  }

  /**
   * Check if a user is allowed (from DB or env vars)
   */
  async isAllowed(platform: string, userId: string): Promise<boolean> {
    // Check environment variables first
    if (this.isAllowedByEnv(platform, userId)) {
      return true;
    }

    // Check database
    const db = getKysely();
    const row = await db
      .selectFrom("channel_allowlists")
      .select(
        sql<boolean>`EXISTS(
        SELECT 1 FROM channel_allowlists
        WHERE platform = ${platform} AND user_id = ${userId}
      )`.as("exists"),
      )
      .executeTakeFirst();

    return row?.exists ?? false;
  }

  /**
   * List all allowed users for a platform
   */
  async listUsers(platform: string): Promise<AllowlistEntry[]> {
    const db = getKysely();

    return db
      .selectFrom("channel_allowlists")
      .selectAll()
      .where("platform", "=", platform)
      .orderBy("created_at", "desc")
      .execute() as unknown as Promise<AllowlistEntry[]>;
  }

  /**
   * Check if user is allowed via environment variables
   */
  private isAllowedByEnv(platform: string, userId: string): boolean {
    const envVarMap: Record<string, string> = {
      discord: "DISCORD_ALLOWED_CHANNELS",
      slack: "SLACK_ALLOWED_CHANNELS",
      telegram: "TELEGRAM_ALLOWED_USERS",
    };

    const envVar = envVarMap[platform.toLowerCase()];
    if (!envVar) {
      return false;
    }

    const allowedList = process.env[envVar];
    if (!allowedList) {
      return false;
    }

    const allowed = allowedList.split(",").map((s) => s.trim());
    return allowed.includes(userId);
  }
}
