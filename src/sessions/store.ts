import { getSessionByKey } from "../db/sessions.ts";
import type { ScopeMode, SessionScope } from "./types.ts";

/**
 * Manages SDK session IDs keyed by platform, channel, and user context.
 * Builds session keys based on the configured scope mode.
 *
 * Uses an in-memory cache backed by the DB sessions table.
 * On cache miss, looks up the SDK session ID from the DB metadata column.
 */
export class SessionStore {
  private readonly sessions = new Map<string, string>();
  private readonly scopeMode: ScopeMode;

  constructor(scopeMode: ScopeMode = "channel") {
    this.scopeMode = scopeMode;
  }

  /**
   * Builds a session key based on the scope mode and provided context.
   */
  private buildKey(scope: SessionScope): string {
    switch (this.scopeMode) {
      case "channel":
        if (!scope.channelId) {
          throw new Error("channelId is required for channel scope mode");
        }
        return `${scope.platform}:${scope.channelId}`;

      case "sender":
        if (!scope.channelId || !scope.userId) {
          throw new Error("channelId and userId are required for sender scope mode");
        }
        return `${scope.platform}:${scope.channelId}:${scope.userId}`;

      case "peer":
        if (!scope.userId) {
          throw new Error("userId is required for peer scope mode");
        }
        return `${scope.platform}:${scope.userId}`;

      case "channel-peer":
        if (!scope.channelId || !scope.userId) {
          throw new Error("channelId and userId are required for channel-peer scope mode");
        }
        return `${scope.platform}:${scope.channelId}:${scope.userId}`;

      default:
        throw new Error(`Unknown scope mode: ${this.scopeMode}`);
    }
  }

  /**
   * Retrieves the session ID for the given scope, if it exists.
   * Checks in-memory cache first, then falls back to DB.
   */
  get(scope: SessionScope): string | undefined {
    const key = this.buildKey(scope);
    return this.sessions.get(key);
  }

  /**
   * Retrieves the session ID, falling back to DB lookup.
   * Use this when you need guaranteed persistence across restarts.
   */
  async getWithDbFallback(scope: SessionScope): Promise<string | undefined> {
    const key = this.buildKey(scope);

    // Check in-memory cache first
    const cached = this.sessions.get(key);
    if (cached) return cached;

    // Fall back to DB
    try {
      const dbSession = await getSessionByKey(key);
      if (dbSession) {
        const sdkId = (dbSession.metadata as Record<string, unknown>)?.sdkSessionId;
        if (typeof sdkId === "string") {
          this.sessions.set(key, sdkId);
          return sdkId;
        }
      }
    } catch {
      // DB unavailable — return undefined
    }

    return undefined;
  }

  /**
   * Stores a session ID for the given scope (in-memory cache).
   */
  set(scope: SessionScope, sessionId: string): void {
    const key = this.buildKey(scope);
    this.sessions.set(key, sessionId);
  }

  /**
   * Stores a session ID and persists it to the DB.
   */
  async setWithDbPersist(scope: SessionScope, sessionId: string): Promise<void> {
    const key = this.buildKey(scope);
    this.sessions.set(key, sessionId);

    // Persist SDK session ID in the DB sessions metadata
    try {
      const { getDb } = await import("../db/client.ts");
      const db = getDb();
      await db`
        UPDATE sessions SET
          metadata = jsonb_set(COALESCE(metadata, '{}'), '{sdkSessionId}', ${JSON.stringify(sessionId)}::jsonb),
          updated_at = now()
        WHERE session_key = ${key}
      `;
    } catch {
      // DB write failed — in-memory cache still has it
    }
  }

  /**
   * Deletes the session for the given scope.
   */
  delete(scope: SessionScope): void {
    const key = this.buildKey(scope);
    this.sessions.delete(key);
  }
}
