import { getDb } from "../db/client.ts";
import type { PairingRequest, DmPolicy } from "./types.ts";
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
    const sql = getDb();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const [row] = await sql<PairingRequest[]>`
      INSERT INTO pairing_requests (channel, platform, user_id, code, expires_at)
      VALUES (${channel}, ${platform}, ${userId}, ${code}, ${expiresAt})
      RETURNING *
    `;
    return row;
  }

  /**
   * Approve a pairing request and add the user to the allowlist
   */
  async approveRequest(code: string): Promise<PairingRequest | null> {
    const sql = getDb();

    // Find pending request
    const [request] = await sql<PairingRequest[]>`
      SELECT * FROM pairing_requests
      WHERE code = ${code}
        AND status = 'pending'
        AND expires_at > now()
    `;

    if (!request) {
      return null;
    }

    // Update request status
    const [updated] = await sql<PairingRequest[]>`
      UPDATE pairing_requests
      SET status = 'approved', approved_at = now()
      WHERE id = ${request.id}
      RETURNING *
    `;

    // Add to allowlist
    await this.allowlistStore.addUser(request.platform, request.user_id);

    return updated;
  }

  /**
   * Reject a pairing request
   */
  async rejectRequest(code: string): Promise<PairingRequest | null> {
    const sql = getDb();

    const [updated] = await sql<PairingRequest[]>`
      UPDATE pairing_requests
      SET status = 'rejected'
      WHERE code = ${code}
        AND status = 'pending'
        AND expires_at > now()
      RETURNING *
    `;

    return updated ?? null;
  }

  /**
   * Clean up expired pairing requests
   */
  async cleanExpired(): Promise<number> {
    const sql = getDb();

    const result = await sql`
      DELETE FROM pairing_requests
      WHERE expires_at < now()
    `;

    return result.count ?? 0;
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
    const sql = getDb();

    const [row] = await sql<PairingRequest[]>`
      SELECT * FROM pairing_requests
      WHERE code = ${code}
    `;

    return row ?? null;
  }

  /**
   * List all pending requests for a platform
   */
  async listPendingRequests(platform?: string): Promise<PairingRequest[]> {
    const sql = getDb();

    if (platform) {
      return sql<PairingRequest[]>`
        SELECT * FROM pairing_requests
        WHERE platform = ${platform}
          AND status = 'pending'
          AND expires_at > now()
        ORDER BY created_at DESC
      `;
    }

    return sql<PairingRequest[]>`
      SELECT * FROM pairing_requests
      WHERE status = 'pending'
        AND expires_at > now()
      ORDER BY created_at DESC
    `;
  }
}
