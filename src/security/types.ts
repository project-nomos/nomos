export type DmPolicy = "pairing" | "allowlist" | "open";

export interface PairingRequest {
  id: string;
  channel: string;
  platform: string;
  user_id: string;
  code: string;
  status: "pending" | "approved" | "rejected";
  created_at: Date;
  expires_at: Date;
  approved_at?: Date;
}

export interface AllowlistEntry {
  id: string;
  platform: string;
  user_id: string;
  added_by?: string;
  created_at: Date;
}
