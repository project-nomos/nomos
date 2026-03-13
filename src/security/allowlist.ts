import process from "node:process";
import { getDb } from "../db/client.ts";
import type { AllowlistEntry } from "./types.ts";

export class AllowlistStore {
  /**
   * Add a user to the allowlist
   */
  async addUser(platform: string, userId: string, addedBy?: string): Promise<AllowlistEntry> {
    const sql = getDb();

    const [row] = await sql<AllowlistEntry[]>`
      INSERT INTO channel_allowlists (platform, user_id, added_by)
      VALUES (${platform}, ${userId}, ${addedBy ?? null})
      ON CONFLICT (platform, user_id) DO UPDATE SET
        added_by = EXCLUDED.added_by,
        created_at = now()
      RETURNING *
    `;

    return row;
  }

  /**
   * Remove a user from the allowlist
   */
  async removeUser(platform: string, userId: string): Promise<boolean> {
    const sql = getDb();

    const result = await sql`
      DELETE FROM channel_allowlists
      WHERE platform = ${platform} AND user_id = ${userId}
    `;

    return (result.count ?? 0) > 0;
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
    const sql = getDb();
    const [row] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM channel_allowlists
        WHERE platform = ${platform} AND user_id = ${userId}
      ) as exists
    `;

    return row?.exists ?? false;
  }

  /**
   * List all allowed users for a platform
   */
  async listUsers(platform: string): Promise<AllowlistEntry[]> {
    const sql = getDb();

    return sql<AllowlistEntry[]>`
      SELECT * FROM channel_allowlists
      WHERE platform = ${platform}
      ORDER BY created_at DESC
    `;
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
