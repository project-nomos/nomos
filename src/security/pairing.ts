import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import type { PairingRequest } from "./types.ts";
import { AllowlistStore } from "./allowlist.ts";

/**
 * Generate an 8-character alphanumeric pairing code
 */
export function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar-looking chars
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export class PairingStore {
  private allowlistStore: AllowlistStore;

  constructor() {
    this.allowlistStore = new AllowlistStore();
  }

  /**
   * Create a new pairing request with a generated code
   */
  async createRequest(
    channel: string,
    platform: string,
    userId: string,
    code: string,
    ttlMinutes: number = 60,
  ): Promise<PairingRequest> {
    const db = getKysely();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const row = await db
      .insertInto("pairing_requests")
      .values({ channel, platform, user_id: userId, code, expires_at: expiresAt })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as PairingRequest;
  }

  /**
   * Approve a pairing request and add the user to the allowlist
   */
  async approveRequest(code: string): Promise<PairingRequest | null> {
    const db = getKysely();

    // Find pending request
    const request = await db
      .selectFrom("pairing_requests")
      .selectAll()
      .where("code", "=", code)
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    if (!request) return null;

    // Update request status
    const updated = await db
      .updateTable("pairing_requests")
      .set({ status: "approved", approved_at: sql`now()` })
      .where("id", "=", request.id)
      .returningAll()
      .executeTakeFirst();

    // Add to allowlist
    await this.allowlistStore.addUser(request.platform, request.user_id);

    return (updated as unknown as PairingRequest) ?? null;
  }

  /**
   * Reject a pairing request
   */
  async rejectRequest(code: string): Promise<PairingRequest | null> {
    const db = getKysely();

    const updated = await db
      .updateTable("pairing_requests")
      .set({ status: "rejected" })
      .where("code", "=", code)
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();

    return (updated as unknown as PairingRequest) ?? null;
  }

  /**
   * Clean up expired pairing requests
   */
  async cleanExpired(): Promise<number> {
    const db = getKysely();
    const result = await db
      .deleteFrom("pairing_requests")
      .where("expires_at", "<", sql<Date>`now()`)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  /**
   * Check if a user is paired (approved)
   */
  async isPaired(platform: string, userId: string): Promise<boolean> {
    return this.allowlistStore.isAllowed(platform, userId);
  }

  /**
   * Get a pairing request by code
   */
  async getRequest(code: string): Promise<PairingRequest | null> {
    const db = getKysely();
    const row = await db
      .selectFrom("pairing_requests")
      .selectAll()
      .where("code", "=", code)
      .executeTakeFirst();
    return (row as unknown as PairingRequest) ?? null;
  }

  /**
   * List all pending requests for a platform
   */
  async listPendingRequests(platform?: string): Promise<PairingRequest[]> {
    const db = getKysely();
    let query = db
      .selectFrom("pairing_requests")
      .selectAll()
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("created_at", "desc");

    if (platform) {
      query = query.where("platform", "=", platform);
    }

    return query.execute() as unknown as Promise<PairingRequest[]>;
  }
}
