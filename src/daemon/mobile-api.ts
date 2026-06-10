/**
 * MobileApi gRPC service. Surfaces five tab-shaped RPC groups for the Expo
 * mobile app:
 *   Chat   — streaming chat, draft approval, message history
 *   Inbox  — CATE inbound queue (Phase 5b table)
 *   Skills — list + toggle bundled skills
 *   Earnings — cost-tracker + bond receipts (stub until real data lands)
 *   Settings — profile, trust tiers, permissions, integrations, OAuth start
 *   Devices — push token registration
 *
 * Every method is wrapped in `withAuthUnary` / `withAuthStream` so the JWT
 * interceptor resolves a TenantContext before the handler runs. The
 * OAuthDeposit service is separately authenticated via mTLS and not part of
 * this surface.
 */

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import * as grpc from "@grpc/grpc-js";
import type { MessageQueue } from "./message-queue.ts";
import type { DraftManager } from "./draft-manager.ts";
import type { AgentEvent, IncomingMessage } from "./types.ts";
import { getKysely } from "../db/client.ts";
import { listIntegrations } from "../db/integrations.ts";
import {
  buildAuthUrl,
  exchangeCode,
  googleRedirectUri,
  GOOGLE_SCOPES,
  isGoogleIntegrationConfigured,
  listGoogleAccounts,
  removeGoogleAccount,
  setSendEnabled,
  signOAuthState,
  storeGoogleAccount,
  verifyOAuthState,
} from "../auth/google-integration.ts";
import { loadSkills } from "../skills/loader.ts";
import { getProjection, neighborhood, searchNodes } from "../memory/graph.ts";
import type { GraphNode, GraphEdge } from "../memory/graph.ts";
import { withAuthUnary, withAuthStream } from "../auth/grpc-interceptor.ts";
import { registerDevice, unregisterDevice } from "./push-notifications.ts";
import { vaultDelete, vaultList, vaultRead, vaultWrite } from "../memory/vault.ts";
import { CronStore } from "../cron/store.ts";
import { createLogger } from "../lib/logger.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";

const log = createLogger("mobile-api");

const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "https://auth.mynomos.ai";

export interface MobileApiDeps {
  messageQueue: MessageQueue;
  draftManager: DraftManager | null;
}

/**
 * Build the service object passed to `server.addService(MobileApiService, …)`.
 */
export function buildMobileApiHandlers(deps: MobileApiDeps) {
  return {
    Chat: withAuthStream("/nomos.MobileApi/Chat", (call, ctx) => handleChat(deps, call, ctx)),
    GetMessages: withAuthUnary("/nomos.MobileApi/GetMessages", (call, ctx) =>
      handleGetMessages(call, ctx),
    ),
    ApproveDraft: withAuthUnary("/nomos.MobileApi/ApproveDraft", (call, ctx) =>
      handleApproveDraft(deps, call, ctx),
    ),
    RejectDraft: withAuthUnary("/nomos.MobileApi/RejectDraft", (call, ctx) =>
      handleRejectDraft(deps, call, ctx),
    ),
    ApproveDraftWithEdit: withAuthUnary("/nomos.MobileApi/ApproveDraftWithEdit", (call, ctx) =>
      handleApproveDraftWithEdit(deps, call, ctx),
    ),
    ListInbox: withAuthUnary("/nomos.MobileApi/ListInbox", (call, ctx) =>
      handleListInbox(call, ctx),
    ),
    GetCateEnvelope: withAuthUnary("/nomos.MobileApi/GetCateEnvelope", (call, ctx) =>
      handleGetCateEnvelope(call, ctx),
    ),
    ActOnInboxItem: withAuthUnary("/nomos.MobileApi/ActOnInboxItem", (call, ctx) =>
      handleActOnInboxItem(call, ctx),
    ),
    ListSkills: withAuthUnary("/nomos.MobileApi/ListSkills", () => handleListSkills()),
    ToggleSkill: withAuthUnary("/nomos.MobileApi/ToggleSkill", (call) => handleToggleSkill(call)),
    GetEarnings: withAuthUnary("/nomos.MobileApi/GetEarnings", () => handleGetEarnings()),
    GetGraph: withAuthUnary("/nomos.MobileApi/GetGraph", (call, ctx) => handleGetGraph(call, ctx)),
    GetGraphNeighbors: withAuthUnary("/nomos.MobileApi/GetGraphNeighbors", (call, ctx) =>
      handleGetGraphNeighbors(call, ctx),
    ),
    SearchGraph: withAuthUnary("/nomos.MobileApi/SearchGraph", (call, ctx) =>
      handleSearchGraph(call, ctx),
    ),
    GetSettings: withAuthUnary("/nomos.MobileApi/GetSettings", (_, ctx) => handleGetSettings(ctx)),
    UpdateConsent: withAuthUnary("/nomos.MobileApi/UpdateConsent", (call) =>
      handleUpdateConsent(call),
    ),
    UpdateTrustTier: withAuthUnary("/nomos.MobileApi/UpdateTrustTier", (call) =>
      handleUpdateTrustTier(call),
    ),
    UpdatePermission: withAuthUnary("/nomos.MobileApi/UpdatePermission", (call) =>
      handleUpdatePermission(call),
    ),
    ListIntegrations: withAuthUnary("/nomos.MobileApi/ListIntegrations", (_, ctx) =>
      handleListIntegrations(ctx),
    ),
    StartConnectIntegration: withAuthUnary(
      "/nomos.MobileApi/StartConnectIntegration",
      (call, ctx) => handleStartConnect(call, ctx),
    ),
    ConnectGoogleAccount: withAuthUnary("/nomos.MobileApi/ConnectGoogleAccount", (call, ctx) =>
      handleConnectGoogleAccount(call, ctx),
    ),
    SetGoogleSend: withAuthUnary("/nomos.MobileApi/SetGoogleSend", (call, ctx) =>
      handleSetGoogleSend(call, ctx),
    ),
    DisconnectIntegration: withAuthUnary("/nomos.MobileApi/DisconnectIntegration", (call, ctx) =>
      handleDisconnect(call, ctx),
    ),
    RegisterDevice: withAuthUnary("/nomos.MobileApi/RegisterDevice", (call, ctx) =>
      handleRegisterDevice(call, ctx),
    ),
    UnregisterDevice: withAuthUnary("/nomos.MobileApi/UnregisterDevice", (call) =>
      handleUnregisterDevice(call),
    ),
    ListVaultNotes: withAuthUnary("/nomos.MobileApi/ListVaultNotes", (call, ctx) =>
      handleListVaultNotes(call, ctx),
    ),
    GetVaultNote: withAuthUnary("/nomos.MobileApi/GetVaultNote", (call, ctx) =>
      handleGetVaultNote(call, ctx),
    ),
    WriteVaultNote: withAuthUnary("/nomos.MobileApi/WriteVaultNote", (call, ctx) =>
      handleWriteVaultNote(call, ctx),
    ),
    DeleteVaultNote: withAuthUnary("/nomos.MobileApi/DeleteVaultNote", (call, ctx) =>
      handleDeleteVaultNote(call, ctx),
    ),
    ListLoops: withAuthUnary("/nomos.MobileApi/ListLoops", (_, ctx) => handleListLoops(ctx)),
    SetLoopEnabled: withAuthUnary("/nomos.MobileApi/SetLoopEnabled", (call, ctx) =>
      handleSetLoopEnabled(call, ctx),
    ),
    DeleteLoop: withAuthUnary("/nomos.MobileApi/DeleteLoop", (call, ctx) =>
      handleDeleteLoop(call, ctx),
    ),
  };
}

// ──────────── Chat ────────────

function handleChat(
  deps: MobileApiDeps,
  call: grpc.ServerWritableStream<unknown, { type: string; jsonPayload: string }>,
  ctx: TenantContext,
): void {
  const req = (call.request ?? {}) as { sessionKey?: string; content?: string };
  const sessionKey = req.sessionKey || `mobile:${ctx.userId}`;
  const content = req.content ?? "";

  const incoming: IncomingMessage = {
    id: randomUUID(),
    platform: "mobile",
    channelId: sessionKey,
    userId: ctx.userId,
    content,
    timestamp: new Date(),
  };

  const emit = (event: AgentEvent) => {
    try {
      const { type, ...rest } = event;
      call.write({ type, jsonPayload: JSON.stringify(rest) });
    } catch {
      // stream cancelled
    }
  };

  deps.messageQueue
    .enqueue(sessionKey, incoming, emit)
    .then(() => call.end())
    .catch((err: unknown) => {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      call.end();
    });
}

async function handleGetMessages(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ messages: Array<{ id: string; role: string; content: string; createdAt: string }> }> {
  const limit = Math.min((call.request as any).limit || 50, 200);
  const sessionKey = (call.request as any).sessionKey;
  const db = getKysely();

  const session = await db
    .selectFrom("sessions")
    .select("id")
    .where("session_key", "=", sessionKey)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  if (!session) return { messages: [] };

  const rows = await db
    .selectFrom("transcript_messages")
    .selectAll()
    .where("session_id", "=", session.id)
    .orderBy("id", "desc")
    .limit(limit)
    .execute();

  return {
    messages: rows.reverse().map((r) => ({
      id: String(r.id),
      role: r.role,
      content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      createdAt: r.created_at.toISOString(),
    })),
  };
}

// ──────────── Brain (knowledge graph) ────────────

interface WireGraphNode {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  summary: string;
  confidence: number;
  externalKind: string;
  externalRef: string;
}
interface WireGraphEdge {
  id: string;
  srcId: string;
  dstId: string;
  relType: string;
  fact: string;
  weight: number;
}

function wireNode(n: GraphNode): WireGraphNode {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    aliases: n.aliases,
    summary: n.summary ?? "",
    confidence: n.confidence,
    externalKind: n.externalKind ?? "",
    externalRef: n.externalRef ?? "",
  };
}
function wireEdge(e: GraphEdge): WireGraphEdge {
  return {
    id: e.id,
    srcId: e.srcId,
    dstId: e.dstId,
    relType: e.relType,
    fact: e.fact ?? "",
    weight: e.weight,
  };
}

/** Brain tab: global graph projection (nodes + edges among them), user-scoped. */
async function handleGetGraph(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ nodes: WireGraphNode[]; edges: WireGraphEdge[] }> {
  const req = (call.request ?? {}) as { kinds?: string[]; limit?: number };
  const kinds = Array.isArray(req.kinds) && req.kinds.length ? req.kinds : undefined;
  const sub = await getProjection(ctx, { kinds, limit: Math.min(req.limit || 500, 5000) });
  return { nodes: sub.nodes.map(wireNode), edges: sub.edges.map(wireEdge) };
}

/** Brain tab: depth-bounded local graph (ego-network) around a node, user-scoped. */
async function handleGetGraphNeighbors(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ nodes: WireGraphNode[]; edges: WireGraphEdge[] }> {
  const req = (call.request ?? {}) as {
    nodeId?: string;
    depth?: number;
    relTypes?: string[];
    direction?: string;
  };
  if (!req.nodeId) return { nodes: [], edges: [] };
  const direction = req.direction === "in" || req.direction === "out" ? req.direction : "both";
  const sub = await neighborhood(ctx, req.nodeId, {
    depth: req.depth || 2,
    relTypes: Array.isArray(req.relTypes) && req.relTypes.length ? req.relTypes : undefined,
    direction,
  });
  return { nodes: sub.nodes.map(wireNode), edges: sub.edges.map(wireEdge) };
}

/** Brain tab: resolve a name to nodes (trigram + cosine), user-scoped. */
async function handleSearchGraph(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ nodes: WireGraphNode[]; edges: WireGraphEdge[] }> {
  const req = (call.request ?? {}) as { query?: string; limit?: number };
  const nodes = await searchNodes(ctx, req.query ?? "", { limit: Math.min(req.limit || 10, 50) });
  return { nodes: nodes.map(wireNode), edges: [] };
}

async function handleApproveDraft(
  deps: MobileApiDeps,
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  if (!deps.draftManager) return { success: false, message: "draft_manager_unavailable" };
  try {
    const mgr = deps.draftManager as DraftManager & {
      approve?: (id: string, userId: string) => Promise<void>;
    };
    if (typeof mgr.approve === "function") {
      await mgr.approve((call.request as any).draftId, ctx.userId);
    }
    return { success: true, message: "approved" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "approve_failed" };
  }
}

async function handleRejectDraft(
  deps: MobileApiDeps,
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  if (!deps.draftManager) return { success: false, message: "draft_manager_unavailable" };
  try {
    const mgr = deps.draftManager as DraftManager & {
      reject?: (id: string, userId: string) => Promise<void>;
    };
    if (typeof mgr.reject === "function") {
      await mgr.reject((call.request as any).draftId, ctx.userId);
    }
    return { success: true, message: "rejected" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "reject_failed" };
  }
}

async function handleApproveDraftWithEdit(
  deps: MobileApiDeps,
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  if (!deps.draftManager) return { success: false, message: "draft_manager_unavailable" };
  try {
    const mgr = deps.draftManager as DraftManager & {
      approveWithEdit?: (id: string, edited: string, userId: string) => Promise<void>;
      approve?: (id: string, userId: string) => Promise<void>;
    };
    if (typeof mgr.approveWithEdit === "function") {
      await mgr.approveWithEdit(
        (call.request as any).draftId,
        (call.request as any).editedText,
        ctx.userId,
      );
    } else if (typeof mgr.approve === "function") {
      await mgr.approve((call.request as any).draftId, ctx.userId);
    }
    return { success: true, message: "approved_with_edit" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "approve_failed" };
  }
}

// ──────────── Inbox (CATE) ────────────

async function handleListInbox(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{
  items: Array<{
    id: string;
    fromLabel: string;
    trustTier: string;
    subject: string;
    time: string;
    bondAmount: string;
    unread: boolean;
    createdAt: string;
  }>;
  blockedCount: number;
}> {
  const status = (call.request as any).status || "pending";
  const limit = Math.min((call.request as any).limit || 50, 200);
  const db = getKysely();

  try {
    const rowsRes = await db.executeQuery(
      sql<{
        id: string;
        from_label: string | null;
        trust_tier: string;
        subject: string | null;
        bond_amount: string | null;
        status: string;
        created_at: Date;
      }>`
        SELECT id, from_label, trust_tier, subject, bond_amount::text AS bond_amount, status, created_at
        FROM cate_inbound
        WHERE user_id = ${ctx.userId}
          ${status === "all" ? sql`` : sql`AND status = ${status}`}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `.compile(db),
    );
    const blockedRes = await db.executeQuery(
      sql<{
        count: string;
      }>`SELECT COUNT(*)::text AS count FROM cate_inbound WHERE user_id = ${ctx.userId} AND status = 'denied'`.compile(
        db,
      ),
    );

    return {
      items: rowsRes.rows.map((r) => ({
        id: r.id,
        fromLabel: r.from_label ?? "",
        trustTier: r.trust_tier,
        subject: r.subject ?? "",
        time: r.created_at.toISOString(),
        bondAmount: r.bond_amount ?? "",
        unread: r.status === "pending",
        createdAt: r.created_at.toISOString(),
      })),
      blockedCount: Number(blockedRes.rows[0]?.count ?? 0),
    };
  } catch {
    // Table may not exist yet (pre-Phase-5b); empty inbox is acceptable.
    return { items: [], blockedCount: 0 };
  }
}

async function handleGetCateEnvelope(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{
  did: string;
  trustTier: string;
  intent: string;
  consentGrant: string;
  stamp: string;
  bondAmount: string;
  rawJson: string;
}> {
  const db = getKysely();
  try {
    const r = await db.executeQuery(
      sql<{
        envelope: Record<string, unknown> | null;
        trust_tier: string;
        bond_amount: string | null;
      }>`
        SELECT envelope, trust_tier, bond_amount::text AS bond_amount
        FROM cate_inbound
        WHERE id = ${(call.request as any).inboxId} AND user_id = ${ctx.userId}
      `.compile(db),
    );
    const row = r.rows[0];
    if (!row) {
      return {
        did: "",
        trustTier: "unknown",
        intent: "",
        consentGrant: "",
        stamp: "",
        bondAmount: "",
        rawJson: "{}",
      };
    }
    const env = (row.envelope ?? {}) as Record<string, unknown>;
    return {
      did: String(env.from_did ?? ""),
      trustTier: row.trust_tier,
      intent: String(env.intent ?? ""),
      consentGrant: String(env.consent_grant ?? ""),
      stamp: String(env.stamp ?? ""),
      bondAmount: row.bond_amount ?? "",
      rawJson: JSON.stringify(env),
    };
  } catch (err) {
    log.warn({ err }, "GetCateEnvelope failed");
    throw err;
  }
}

async function handleActOnInboxItem(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const validActions = new Set(["approve", "deny", "block"]);
  if (!validActions.has((call.request as any).action)) {
    return { success: false, message: "invalid_action" };
  }
  const newStatus = (call.request as any).action === "approve" ? "approved" : "denied";
  const db = getKysely();
  try {
    await db.executeQuery(
      sql`
        UPDATE cate_inbound
        SET status = ${newStatus}, acted_at = now()
        WHERE id = ${(call.request as any).inboxId} AND user_id = ${ctx.userId}
      `.compile(db),
    );
    return { success: true, message: newStatus };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "act_failed" };
  }
}

// ──────────── Skills ────────────

async function handleListSkills(): Promise<{
  skills: Array<{
    name: string;
    description: string;
    source: string;
    enabled: boolean;
    certs: string[];
    price: string;
  }>;
}> {
  const skills = loadSkills().map((s) => ({
    name: s.name,
    description: s.description ?? "",
    source: s.source,
    enabled: true,
    certs: [] as string[],
    price: "Free",
  }));
  return { skills };
}

async function handleToggleSkill(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  const db = getKysely();
  const key = `skill.${(call.request as any).name}.enabled`;
  await db
    .insertInto("config")
    .values({ key, value: JSON.stringify((call.request as any).enabled) })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        value: JSON.stringify((call.request as any).enabled),
        updated_at: new Date(),
      }),
    )
    .execute();
  return { success: true, message: (call.request as any).enabled ? "enabled" : "disabled" };
}

// ──────────── Earnings (stub) ────────────

async function handleGetEarnings(): Promise<{
  thisPeriodCents: number;
  bondsCount: number;
  avgBondCents: number;
  acceptRatePct: number;
  seriesCents: number[];
}> {
  return {
    thisPeriodCents: 0,
    bondsCount: 0,
    avgBondCents: 0,
    acceptRatePct: 0,
    seriesCents: new Array(14).fill(0),
  };
}

// ──────────── Settings ────────────

async function handleGetSettings(ctx: TenantContext) {
  const integrations = await listIntegrationsForUser(ctx.userId);
  return {
    profile: {
      name: "Nomos",
      plan: "Pro",
      messageCount: 0,
      earnedCents: 0,
      savedCents: 0,
    },
    trustTiers: [
      {
        id: "friends",
        name: "Friends",
        description: "Always allowed",
        mode: "free",
        bondAmount: "",
      },
      {
        id: "healthcare",
        name: "Healthcare",
        description: "Verified professionals",
        mode: "free",
        bondAmount: "",
      },
      {
        id: "brands",
        name: "Brands",
        description: "Min bid per impression",
        mode: "bond",
        bondAmount: "0.05",
      },
      {
        id: "unknown",
        name: "Unknown",
        description: "No identity = blocked",
        mode: "blocked",
        bondAmount: "",
      },
    ],
    permissions: [
      { id: "p1", label: "Read emails", enabled: true },
      { id: "p2", label: "Draft replies", enabled: true },
      { id: "p3", label: "Send (with approval)", enabled: true },
      { id: "p4", label: "Send (auto)", enabled: false },
      { id: "p5", label: "Schedule meetings", enabled: true },
      { id: "p6", label: "Make purchases", enabled: false },
    ],
    integrations,
  };
}

async function setConfigKey(key: string, value: unknown): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("config")
    .values({ key, value: JSON.stringify(value) })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        value: JSON.stringify(value),
        updated_at: new Date(),
      }),
    )
    .execute();
}

async function handleUpdateConsent(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  await setConfigKey(`consent.${(call.request as any).platform}`, (call.request as any).mode);
  return { success: true, message: "ok" };
}

async function handleUpdateTrustTier(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  await setConfigKey(`trust_tier.${(call.request as any).id}`, {
    mode: (call.request as any).mode,
    bondAmount: (call.request as any).bondAmount,
  });
  return { success: true, message: "ok" };
}

async function handleUpdatePermission(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  await setConfigKey(`permission.${(call.request as any).id}`, (call.request as any).enabled);
  return { success: true, message: "ok" };
}

async function handleListIntegrations(ctx: TenantContext) {
  return { integrations: await listIntegrationsForUser(ctx.userId) };
}

async function handleStartConnect(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ oauthUrl: string }> {
  const provider = String((call.request as { provider?: string }).provider ?? "");
  // Google (gmail/calendar/drive are aliases of one grant): the daemon owns the
  // OAuth — build the consent URL with a signed CSRF state; the callback relays
  // the code back via ConnectGoogleAccount.
  if (["google", "gmail", "calendar", "drive"].includes(provider)) {
    if (!isGoogleIntegrationConfigured()) {
      throw new Error(
        "Google integration not configured (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)",
      );
    }
    const url = buildAuthUrl({
      redirectUri: googleRedirectUri(),
      state: signOAuthState(ctx.userId),
    });
    return { oauthUrl: url };
  }
  // Other providers still go through the central auth server.
  const url = `${AUTH_BASE_URL}/api/oauth/${encodeURIComponent(provider)}/start`;
  return { oauthUrl: url };
}

async function handleConnectGoogleAccount(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { code?: string; state?: string };
  if (!req.code) return { success: false, message: "missing_code" };
  if (!req.state || !verifyOAuthState(req.state, ctx.userId)) {
    return { success: false, message: "invalid_state" };
  }
  try {
    const tokens = await exchangeCode({ code: req.code, redirectUri: googleRedirectUri() });
    await storeGoogleAccount({
      userId: ctx.userId,
      email: tokens.email,
      tokens,
      scopes: tokens.scope ?? GOOGLE_SCOPES.join(" "),
    });
    return { success: true, message: tokens.email };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "Google connect failed");
    return { success: false, message: err instanceof Error ? err.message : "connect_failed" };
  }
}

async function handleSetGoogleSend(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { accountEmail?: string; enabled?: boolean };
  if (!req.accountEmail) return { success: false, message: "missing_account_email" };
  try {
    await setSendEnabled(ctx.userId, req.accountEmail, Boolean(req.enabled));
    return { success: true, message: req.enabled ? "send_enabled" : "send_disabled" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "failed" };
  }
}

async function handleDisconnect(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { accountEmail?: string; integrationId?: string };
  // Google: disconnect by account email.
  if (req.accountEmail) {
    await removeGoogleAccount(ctx.userId, req.accountEmail);
    return { success: true, message: "disconnected" };
  }
  // Legacy: disconnect by deposited integration_id.
  const db = getKysely();
  await db
    .deleteFrom("integrations")
    .where(sql`metadata->>'integration_id'`, "=", req.integrationId ?? "")
    .where(sql`config->>'user_id'`, "=", ctx.userId)
    .execute();
  return { success: true, message: "disconnected" };
}

// ──────────── Devices ────────────

async function handleRegisterDevice(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  if ((call.request as any).platform !== "ios" && (call.request as any).platform !== "android") {
    return { success: false, message: "invalid_platform" };
  }
  await registerDevice(ctx.userId, {
    expoPushToken: (call.request as any).expoPushToken,
    platform: (call.request as any).platform,
    appVersion: (call.request as any).appVersion || undefined,
  });
  return { success: true, message: "registered" };
}

async function handleUnregisterDevice(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  await unregisterDevice((call.request as any).expoPushToken);
  return { success: true, message: "unregistered" };
}

// ──────────── Vault (long-term memory / knowledge base) ────────────

async function handleListVaultNotes(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ notes: Array<{ path: string; title: string; updatedAt: string }> }> {
  const prefix = (call.request as { prefix?: string }).prefix || undefined;
  const notes = await vaultList(resolveMemoryUserId(ctx.userId), prefix);
  return {
    notes: notes.map((n) => ({
      path: n.path,
      title: n.title,
      updatedAt: n.updatedAt.toISOString(),
    })),
  };
}

async function handleGetVaultNote(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ path: string; title: string; content: string; updatedAt: string; exists: boolean }> {
  const path = (call.request as { path?: string }).path ?? "";
  const note = await vaultRead(resolveMemoryUserId(ctx.userId), path);
  if (!note) return { path, title: "", content: "", updatedAt: "", exists: false };
  return {
    path: note.path,
    title: note.title,
    content: note.content,
    updatedAt: note.updatedAt.toISOString(),
    exists: true,
  };
}

async function handleWriteVaultNote(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { path?: string; content?: string; title?: string };
  if (!req.path) return { success: false, message: "missing_path" };
  try {
    await vaultWrite(resolveMemoryUserId(ctx.userId), req.path, req.content ?? "", {
      title: req.title || undefined,
    });
    return { success: true, message: "saved" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "write_failed" };
  }
}

async function handleDeleteVaultNote(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const path = (call.request as { path?: string }).path ?? "";
  try {
    await vaultDelete(resolveMemoryUserId(ctx.userId), path);
    return { success: true, message: "deleted" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "delete_failed" };
  }
}

// ──────────── Loops (autonomous recurring jobs) ────────────
// Owner-scoped via the JWT-resolved user. System infra jobs are never mutable
// here (they belong to the daemon); these handlers run in the daemon process, so
// they emit cron:refresh directly to apply a change live.

async function handleListLoops(ctx: TenantContext): Promise<{
  loops: Array<{
    id: string;
    name: string;
    schedule: string;
    enabled: boolean;
    source: string;
    errorCount: number;
    lastRun: string;
    prompt: string;
  }>;
}> {
  const userId = resolveMemoryUserId(ctx.userId);
  const jobs = await new CronStore().listJobs({ userId });
  return {
    loops: jobs
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        enabled: j.enabled,
        source: j.source ?? "system",
        errorCount: j.errorCount,
        lastRun: j.lastRun ? j.lastRun.toISOString() : "",
        prompt: j.prompt,
      })),
  };
}

async function handleSetLoopEnabled(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { name?: string; enabled?: boolean };
  if (!req.name) return { success: false, message: "missing_name" };
  const userId = resolveMemoryUserId(ctx.userId);
  const store = new CronStore();
  const job = await store.getJobByName(req.name);
  if (!job || job.userId !== userId) return { success: false, message: "loop_not_found" };
  if (job.source === "system") return { success: false, message: "system_job_read_only" };
  await store.updateJob(job.id, { enabled: Boolean(req.enabled) });
  process.emit("cron:refresh" as never);
  return { success: true, message: req.enabled ? "enabled" : "disabled" };
}

async function handleDeleteLoop(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { name?: string };
  if (!req.name) return { success: false, message: "missing_name" };
  const userId = resolveMemoryUserId(ctx.userId);
  const store = new CronStore();
  const job = await store.getJobByName(req.name);
  if (!job || job.userId !== userId) return { success: false, message: "loop_not_found" };
  if (job.source === "system") return { success: false, message: "system_job_read_only" };
  await store.deleteJob(job.id);
  process.emit("cron:refresh" as never);
  return { success: true, message: "deleted" };
}

// Helpers
async function listIntegrationsForUser(userId: string) {
  const all = await listIntegrations();
  return all
    .filter((i) => i.config.user_id === userId || i.config.user_id === undefined)
    .map((i) => {
      const provider = String(i.config.provider ?? i.name);
      const accountEmail = String(i.config.account_email ?? "");
      const isGoogle = provider === "google";
      return {
        // Google: key by account email so the client disconnects/toggles by account.
        id: isGoogle && accountEmail ? accountEmail : String(i.metadata.integration_id ?? i.id),
        label: isGoogle ? "Google" : provider,
        icon: isGoogle ? "mail" : String(i.config.icon ?? "plug"),
        connected: i.enabled,
        accountEmail,
        sendEnabled: Boolean(i.config.send_enabled),
        provider,
      };
    });
}
