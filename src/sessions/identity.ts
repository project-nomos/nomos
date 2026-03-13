import { getDb } from "../db/client.ts";

/**
 * Linked user identity across platforms.
 */
export interface LinkedIdentity {
  platform: string;
  userId: string;
}

/**
 * Manages cross-platform user identity linking.
 * Allows linking the same user across different platforms (e.g., Discord + Slack).
 */
export class IdentityLinker {
  /**
   * Ensures the user_identities table exists.
   */
  async initialize(): Promise<void> {
    const db = getDb();
    await db`
      CREATE TABLE IF NOT EXISTS user_identities (
        id SERIAL PRIMARY KEY,
        platform1 TEXT NOT NULL,
        user_id1 TEXT NOT NULL,
        platform2 TEXT NOT NULL,
        user_id2 TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(platform1, user_id1, platform2, user_id2)
      )
    `;
    // Create index for reverse lookups
    await db`
      CREATE INDEX IF NOT EXISTS idx_user_identities_reverse
      ON user_identities(platform2, user_id2, platform1, user_id1)
    `;
  }

  /**
   * Links two user identities across platforms.
   * The link is bidirectional and automatically creates the reverse mapping.
   */
  async link(
    platform1: string,
    userId1: string,
    platform2: string,
    userId2: string,
  ): Promise<void> {
    const db = getDb();
    await this.initialize();

    // Insert both directions to ensure bidirectional lookup
    await db`
      INSERT INTO user_identities (platform1, user_id1, platform2, user_id2)
      VALUES (${platform1}, ${userId1}, ${platform2}, ${userId2})
      ON CONFLICT (platform1, user_id1, platform2, user_id2) DO NOTHING
    `;
    await db`
      INSERT INTO user_identities (platform1, user_id1, platform2, user_id2)
      VALUES (${platform2}, ${userId2}, ${platform1}, ${userId1})
      ON CONFLICT (platform1, user_id1, platform2, user_id2) DO NOTHING
    `;
  }

  /**
   * Retrieves all linked identities for a given user on a platform.
   * Returns an array of linked identities (excluding the input identity itself).
   */
  async getLinked(platform: string, userId: string): Promise<LinkedIdentity[]> {
    const db = getDb();
    await this.initialize();

    const rows = await db<Array<{ platform2: string; user_id2: string }>>`
      SELECT platform2, user_id2
      FROM user_identities
      WHERE platform1 = ${platform} AND user_id1 = ${userId}
    `;

    return rows.map((row) => ({
      platform: row.platform2,
      userId: row.user_id2,
    }));
  }
}
