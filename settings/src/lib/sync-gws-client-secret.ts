/**
 * Write ~/.config/gws/client_secret.json from the OAuth credentials
 * stored in DB/.env. The @googleworkspace/cli reads this file to learn
 * the Client ID/Secret and the GCP project_id that should be used as
 * quotaProjectId on API calls. If project_id is wrong, every API call
 * fails with `Project 'projects/<wrong>' not found or deleted`.
 *
 * Called both from the OAuth start flow and from the Settings save
 * handler (so changing the Project ID alone is enough — no need to
 * force a full re-auth just to fix the project_id field).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GwsClientSecretParams {
  clientId: string;
  clientSecret: string;
  projectId: string;
}

export function gwsClientSecretPath(): string {
  return path.join(os.homedir(), ".config", "gws", "client_secret.json");
}

/**
 * Write client_secret.json with the given OAuth credentials. Returns the path.
 * No-op (returns null) if either the client_id or client_secret is missing.
 */
export function writeGwsClientSecret(params: GwsClientSecretParams): string | null {
  if (!params.clientId || !params.clientSecret) return null;
  const gwsConfigDir = path.join(os.homedir(), ".config", "gws");
  const dest = path.join(gwsConfigDir, "client_secret.json");

  const data = {
    installed: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      project_id: params.projectId || "google-workspace-cli",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
    },
  };

  fs.mkdirSync(gwsConfigDir, { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), { mode: 0o600 });
  return dest;
}
