/**
 * OAuthDeposit gRPC service implementation.
 *
 * The central nomos-server holds the OAuth apps (Google, Slack, Notion, ...)
 * and runs the OAuth dance on the user's behalf. On success, it calls
 * `Deposit` on the target customer instance over mTLS. The customer's
 * instance writes the encrypted tokens into its `integrations` /
 * `google_accounts` / `slack_workspaces` table.
 *
 * Authentication: mTLS client cert signed by the central CA. Verified by
 * the gRPC server's `createSsl` credentials when `MTLS_CA_CERT_PATH` is set.
 *
 * Authorization: this handler trusts the caller (only the central server
 * holds a valid client cert). It checks the request's `user_id` claim
 * against the org-membership table (Phase 4b adds the membership cache).
 */

import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";
import { upsertIntegration } from "../db/integrations.ts";
import { fetchGoogleAccountEmail, storeGoogleAccount } from "../auth/google-integration.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("oauth-deposit");

interface DepositRequestProto {
  provider: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string;
  metadata: Record<string, string>;
}

interface DepositResponseProto {
  success: boolean;
  message: string;
  integrationId: string;
}

export async function depositOAuthCredential(
  call: grpc.ServerUnaryCall<DepositRequestProto, DepositResponseProto>,
  callback: grpc.sendUnaryData<DepositResponseProto>,
): Promise<void> {
  const req = call.request;

  // Defense in depth: refuse depositing tokens for cross-org users. The
  // mTLS layer already keeps random callers out; this guards against bugs
  // in the central server sending tokens to the wrong instance.
  const expectedOrgId = process.env.NOMOS_ORG_ID;
  const callerOrgId = (call.metadata.get("x-nomos-org-id")?.[0] as string | undefined) ?? null;
  if (expectedOrgId && callerOrgId && callerOrgId !== expectedOrgId) {
    log.warn(
      { expectedOrgId, callerOrgId, provider: req.provider },
      "Rejecting cross-org OAuth deposit",
    );
    callback({
      code: grpc.status.PERMISSION_DENIED,
      message: "Org mismatch",
    });
    return;
  }

  try {
    // Google must be stored in the canonical per-account shape the Google MCP
    // builder reads: name `google:{userId}:{email}` with config.account_email /
    // is_default / send_enabled. The generic `provider:userId` row below is
    // INVISIBLE to listGoogleAccounts (prefix `google:{userId}:`), which is why a
    // connected account never produced a calendar tool. Resolve the email from the
    // token and route through storeGoogleAccount.
    if (req.provider === "google") {
      const email = await fetchGoogleAccountEmail(req.accessToken);
      if (!email) {
        callback({
          code: grpc.status.INTERNAL,
          message: "could not resolve Google account email from token",
        });
        return;
      }
      await storeGoogleAccount({
        userId: req.userId,
        email,
        tokens: {
          accessToken: req.accessToken,
          refreshToken: req.refreshToken || undefined,
          expiresAt: req.expiresAt,
          scope: req.scopes,
        },
        scopes: req.scopes,
      });
      log.info({ userId: req.userId, email }, "OAuth credential deposited (google, canonical)");
      callback(null, { success: true, message: "Deposited", integrationId: randomUUID() });
      return;
    }

    // Compose the integration row. Each `provider` gets its own row,
    // scoped by user_id so family-plan members don't trample each other.
    const integrationId = randomUUID();
    const name = `${req.provider}:${req.userId}`;
    await upsertIntegration(name, {
      enabled: true,
      config: {
        provider: req.provider,
        user_id: req.userId,
        scopes: req.scopes,
        ...req.metadata,
      },
      secrets: {
        access_token: req.accessToken,
        refresh_token: req.refreshToken,
        expires_at: String(req.expiresAt),
      },
      metadata: {
        deposited_at: new Date().toISOString(),
        integration_id: integrationId,
      },
    });

    log.info(
      { provider: req.provider, userId: req.userId, integrationId },
      "OAuth credential deposited",
    );

    callback(null, {
      success: true,
      message: "Deposited",
      integrationId,
    });
  } catch (err) {
    log.error({ err, provider: req.provider }, "Deposit failed");
    callback({
      code: grpc.status.INTERNAL,
      message: err instanceof Error ? err.message : "deposit_failed",
    });
  }
}
