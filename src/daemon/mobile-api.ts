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
import { getConfigValue, setConfigValue } from "../db/config.ts";
import { setConsentMode, listConsentModes, type ConsentMode } from "../db/consent-config.ts";
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
import {
  curateConsumerSkills,
  resolveSkillName,
  isConsumerSkill,
  type ConsumerSkill,
} from "../skills/skill-view.ts";
import { BUILTIN_TOOLS } from "../plugins/builtin-tools.ts";
import { getProjection, neighborhood, searchNodes } from "../memory/graph.ts";
import type { GraphNode, GraphEdge } from "../memory/graph.ts";
import { withAuthUnary, withAuthStream } from "../auth/grpc-interceptor.ts";
import { registerDevice, unregisterDevice } from "./push-notifications.ts";
import { vaultDelete, vaultList, vaultRead, vaultWrite } from "../memory/vault.ts";
import { CronStore } from "../cron/store.ts";
import { isLoopUserDisabled, setLoopUserEnabled } from "../cron/loop-overrides.ts";
import {
  curateConsumerLoops,
  MANAGED_LOOPS,
  MANAGED_LABEL_TO_NAME,
  type ConsumerLoop,
} from "../cron/loop-view.ts";
import { curateConsumerTasks, type ConsumerTask } from "../cron/task-view.ts";
import type { CronJobUpdate, ScheduleType } from "../cron/types.ts";
import { getBrainOverview } from "../memory/brain.ts";
import { getInboxOverview } from "./inbox.ts";
import { getTodayOverview } from "./today.ts";
import { createLogger } from "../lib/logger.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { resolveMemoryUserId, systemTenant } from "../auth/tenant-context.ts";
import { buildStudioEngine } from "../sdk/studio-mcp.ts";
import {
  confirmAsset,
  createAsset,
  getAsset,
  getEdit,
  listAssets,
  listEdits,
  recordIdentityScore,
  StaleParentError,
} from "../studio/assets.ts";
import { ConsentRequiredError, isCloudAIEnabled, setCloudAIEnabled } from "../studio/consent.ts";
import { readPhotoStyle } from "../studio/learn.ts";
import { suggestEdits } from "../studio/suggest.ts";
import { getObjectStore, objectKey } from "../storage/object-store.ts";

const log = createLogger("mobile-api");

const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "https://auth.mynomos.ai";

export interface MobileApiDeps {
  messageQueue: MessageQueue;
  draftManager: DraftManager | null;
  /** Late-bound so AnswerQuestion can resolve a pending ask_user elicitation. */
  getElicitationManager?: () => import("./elicitation-manager.ts").ElicitationManager | null;
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
    ListPlugins: withAuthUnary("/nomos.MobileApi/ListPlugins", () => handleListPlugins()),
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
    UpdateAppSetting: withAuthUnary("/nomos.MobileApi/UpdateAppSetting", (call) =>
      handleUpdateAppSetting(call),
    ),
    UpdateAgentIdentity: withAuthUnary("/nomos.MobileApi/UpdateAgentIdentity", (call) =>
      handleUpdateAgentIdentity(call),
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
    ListTasks: withAuthUnary("/nomos.MobileApi/ListTasks", (_, ctx) => handleListTasks(ctx)),
    UpdateTask: withAuthUnary("/nomos.MobileApi/UpdateTask", (call, ctx) =>
      handleUpdateTask(call, ctx),
    ),
    DeleteTask: withAuthUnary("/nomos.MobileApi/DeleteTask", (call, ctx) =>
      handleDeleteTask(call, ctx),
    ),
    AnswerQuestion: withAuthUnary("/nomos.MobileApi/AnswerQuestion", (call, ctx) =>
      handleAnswerQuestion(deps, call, ctx),
    ),
    GetBrain: withAuthUnary("/nomos.MobileApi/GetBrain", (_, ctx) => handleGetBrain(ctx)),
    GetInbox: withAuthUnary("/nomos.MobileApi/GetInbox", (_, ctx) => handleGetInbox(ctx)),
    GetToday: withAuthUnary("/nomos.MobileApi/GetToday", (_, ctx) => handleGetToday(ctx)),

    // Studio (hosted-only feature)
    StudioCreateAsset: withAuthUnary("/nomos.MobileApi/StudioCreateAsset", (call, ctx) =>
      handleStudioCreateAsset(call, ctx),
    ),
    StudioGetAssetUrl: withAuthUnary("/nomos.MobileApi/StudioGetAssetUrl", (call, ctx) =>
      handleStudioGetAssetUrl(call, ctx),
    ),
    StudioEdit: withAuthStream("/nomos.MobileApi/StudioEdit", (call, ctx) =>
      handleStudioEdit(call, ctx),
    ),
    StudioHistory: withAuthUnary("/nomos.MobileApi/StudioHistory", (call, ctx) =>
      handleStudioHistory(call, ctx),
    ),
    StudioListAssets: withAuthUnary("/nomos.MobileApi/StudioListAssets", (call, ctx) =>
      handleStudioListAssets(call, ctx),
    ),
    StudioSuggestEdits: withAuthUnary("/nomos.MobileApi/StudioSuggestEdits", (call, ctx) =>
      handleStudioSuggestEdits(call, ctx),
    ),
    StudioReportIdentity: withAuthUnary("/nomos.MobileApi/StudioReportIdentity", (call, ctx) =>
      handleStudioReportIdentity(call, ctx),
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

async function handleListSkills(): Promise<{ skills: ConsumerSkill[] }> {
  const all = loadSkills();
  // Resolve each surfaced skill's persisted on/off (default on) before curating.
  const enabled = new Map<string, boolean>();
  for (const s of all) {
    if (isConsumerSkill(s)) {
      enabled.set(s.name, (await getConfigValue<boolean>(`skill.${s.name}.enabled`)) ?? true);
    }
  }
  return { skills: curateConsumerSkills(all, (name) => enabled.get(name) ?? true) };
}

async function handleToggleSkill(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { name?: string; enabled?: boolean };
  if (!req.name) return { success: false, message: "missing_name" };
  // The client sends the friendly label; resolve it back to the raw skill name.
  const name = resolveSkillName(loadSkills(), req.name);
  await setConfigValue(`skill.${name}.enabled`, Boolean(req.enabled));
  return { success: true, message: req.enabled ? "enabled" : "disabled" };
}

/** Read-only list of the assistant's out-of-the-box capabilities. The Claude
 * marketplace plugins are all developer tools, so consumers see this curated
 * built-in set instead (marketplace install is a later iteration). */
async function handleListPlugins(): Promise<{
  plugins: Array<{ name: string; description: string; marketplace: string }>;
}> {
  return {
    plugins: BUILTIN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      marketplace: "built-in",
    })),
  };
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

// Catalog of consumer permissions + trust tiers. Labels/defaults are fixed; the
// actual on/off + tier mode are read back from the config table (where the
// UpdatePermission / UpdateTrustTier handlers persist them), so settings
// round-trip instead of returning literals.
const PERMISSION_DEFS = [
  { id: "p1", label: "Read emails", def: true },
  { id: "p2", label: "Draft replies", def: true },
  { id: "p3", label: "Send (with approval)", def: true },
  { id: "p4", label: "Send (auto)", def: false },
  { id: "p5", label: "Schedule meetings", def: true },
  { id: "p6", label: "Make purchases", def: false },
] as const;

const TRUST_TIER_DEFS = [
  { id: "friends", name: "Friends", description: "Always allowed", mode: "free", bondAmount: "" },
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
] as const;

async function handleGetSettings(ctx: TenantContext) {
  const integrations = await listIntegrationsForUser(ctx.userId);

  // Studio cloud-AI consent is stored separately (setCloudAIEnabled), so it's surfaced
  // as its own permission row alongside the config-driven ones.
  const permissions = [
    { id: "studio_cloud_ai", label: "Cloud AI photo edits", enabled: await isCloudAIEnabled() },
    ...(await Promise.all(
      PERMISSION_DEFS.map(async (p) => ({
        id: p.id,
        label: p.label,
        enabled: (await getConfigValue<boolean>(`permission.${p.id}`)) ?? p.def,
      })),
    )),
  ];

  const trustTiers = await Promise.all(
    TRUST_TIER_DEFS.map(async (t) => {
      const stored = await getConfigValue<{ mode?: string; bondAmount?: string }>(
        `trust_tier.${t.id}`,
      );
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        mode: stored?.mode ?? t.mode,
        bondAmount: stored?.bondAmount ?? t.bondAmount,
      };
    }),
  );

  // Usage: real message count for this user; plan/name from config (consumer
  // onboarding sets these; earned/saved stay 0 until CATE bond receipts land).
  const messageCount = await countUserMessages(ctx.userId);
  const profile = {
    name: (await getConfigValue<string>("profile.name")) ?? "",
    plan: (await getConfigValue<string>("profile.plan")) ?? "Free",
    messageCount,
    earnedCents: 0,
    savedCents: 0,
  };

  // Per-platform consent modes (so the app's picker reflects current state).
  const consentModes = await listConsentModes();
  const consent = Object.entries(consentModes).map(([platform, mode]) => ({ platform, mode }));

  // Agent identity (name + voice/tone), and the consumer behavior toggles.
  const identity = {
    name: (await getConfigValue<string>("agent.name")) ?? "Nomos",
    voice: (await getConfigValue<string>("agent.soul")) ?? "",
    avatar: (await getConfigValue<string>("agent.avatar")) ?? "",
  };
  const appToggles = await Promise.all(
    CONSUMER_TOGGLE_KEYS.map(async (key) => ({
      key,
      enabled: (await getConfigValue<boolean>(key)) ?? true,
    })),
  );

  // Proactive agency: autonomy level + daily-briefing schedule.
  const proactive = {
    mode: (await getConfigValue<string>("app.inboxAutonomy")) ?? "passive",
    briefing: (await getConfigValue<string>("app.briefingCron")) ?? "",
  };

  return {
    profile,
    trustTiers,
    permissions,
    integrations,
    consent,
    identity,
    appToggles,
    proactive,
  };
}

/** App-config keys the mobile app may read/flip (consumer-safe bool toggles). */
const CONSUMER_TOGGLE_KEYS = [
  "app.adaptiveMemory",
  "app.commitmentTracking",
  "app.styleMatching",
] as const;

/** Consumer-safe string app-config keys (proactive scheduling, DM policy). */
const CONSUMER_STRING_KEYS = [
  "app.inboxAutonomy",
  "app.briefingCron",
  "app.defaultDmPolicy",
] as const;

async function handleUpdateAppSetting(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { key?: string; value?: string };
  if (req.key && (CONSUMER_TOGGLE_KEYS as readonly string[]).includes(req.key)) {
    await setConfigValue(req.key, req.value === "true");
    return { success: true, message: "ok" };
  }
  if (req.key && (CONSUMER_STRING_KEYS as readonly string[]).includes(req.key)) {
    await setConfigValue(req.key, req.value ?? "");
    return { success: true, message: "ok" };
  }
  return { success: false, message: "key_not_allowed" };
}

async function handleUpdateAgentIdentity(
  call: grpc.ServerUnaryCall<unknown, unknown>,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { name?: string; voice?: string; avatar?: string };
  if (req.name !== undefined) await setConfigValue("agent.name", req.name);
  if (req.voice !== undefined) await setConfigValue("agent.soul", req.voice);
  if (req.avatar !== undefined) await setConfigValue("agent.avatar", req.avatar);
  return { success: true, message: "ok" };
}

/** Count transcript messages belonging to this user (best-effort; 0 on error). */
async function countUserMessages(userId: string): Promise<number> {
  try {
    const db = getKysely();
    const row = await db
      .selectFrom("transcript_messages")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
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
  const req = call.request as { platform?: string; mode?: string };
  if (!req.platform) return { success: false, message: "missing_platform" };
  try {
    // Writes `consent.mode.<platform>` (what DraftManager reads) and validates
    // against always_ask / auto_approve / notify_only.
    await setConsentMode(req.platform, req.mode as ConsentMode);
    return { success: true, message: "ok" };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "invalid_mode" };
  }
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
  const id = String((call.request as { id?: string }).id ?? "");
  const enabled = Boolean((call.request as { enabled?: boolean }).enabled);
  if (id === "studio_cloud_ai") {
    // Studio cloud-AI consent → the boolean key the consent gate reads.
    await setCloudAIEnabled(enabled);
  } else {
    await setConfigKey(`permission.${id}`, enabled);
  }
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
// The instance runs its background loops under the synthetic `system` owner
// (see gateway.ts + proactive/scheduler.ts), so a hosted user owns none of them
// and a naive per-user query returns nothing. The consumer Loops page is an
// audit + control surface, so we ALSO surface a curated set of the always-on
// "managed" loops the assistant runs on the user's behalf -- under a friendly
// label, with a per-user enable/disable override. Those rows are permanently
// enabled, so the override (an AND-gate honored by cron-engine at fire time) can
// meaningfully turn them off without mutating the shared `system` row. Pure infra
// plumbing (wiki/graph/magic-docs/delta-sync) and the proactive family (gated by
// the Proactive setting) are hidden. User/agent-created loops show under their
// real name and toggle the row directly.

async function handleListLoops(_ctx: TenantContext): Promise<{ loops: ConsumerLoop[] }> {
  // Loops = the assistant's always-on background behaviors (owned by the `system`
  // tenant). The user's own scheduled jobs live on the Tasks surface, not here.
  const system = await new CronStore().listJobs({ userId: systemTenant().userId });

  // Which managed loops the user has turned off (folded into `enabled`).
  const optedOut = new Set<string>();
  for (const j of system) {
    if (MANAGED_LOOPS[j.name] && (await isLoopUserDisabled(j.name))) optedOut.add(j.name);
  }

  return { loops: curateConsumerLoops(system, optedOut) };
}

async function handleSetLoopEnabled(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { name?: string; enabled?: boolean };
  if (!req.name) return { success: false, message: "missing_name" };

  // Managed loop: the client sends the friendly label. Persist a per-user
  // override (honored by cron-engine at fire time) instead of mutating the
  // shared `system` row.
  const managedName = MANAGED_LABEL_TO_NAME.get(req.name);
  if (managedName) {
    await setLoopUserEnabled(managedName, Boolean(req.enabled));
    process.emit("cron:refresh" as never);
    return { success: true, message: req.enabled ? "enabled" : "disabled" };
  }

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

// ──────────── Tasks (the user's scheduled tasks) ────────────
// Owner-scoped by user_id: a per-user query never returns the instance's
// `system`-owned background loops, so Tasks and Loops stay cleanly separate.
// Update/Delete additionally assert ownership before mutating.

async function handleListTasks(ctx: TenantContext): Promise<{ tasks: ConsumerTask[] }> {
  const userId = resolveMemoryUserId(ctx.userId);
  const jobs = await new CronStore().listJobs({ userId });
  return { tasks: curateConsumerTasks(jobs) };
}

async function handleUpdateTask(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as {
    id?: string;
    name?: string;
    prompt?: string;
    schedule?: string;
    scheduleType?: string;
    enabled?: boolean;
  };
  if (!req.id) return { success: false, message: "missing_id" };
  const userId = resolveMemoryUserId(ctx.userId);
  const store = new CronStore();
  const job = await store.getJob(req.id);
  if (!job || job.userId !== userId) return { success: false, message: "task_not_found" };

  // Full-state update from the editor; empty name/schedule are ignored so a
  // toggle-only call (which still sends the whole proto) never blanks a field.
  const updates: CronJobUpdate = { enabled: Boolean(req.enabled) };
  if (req.name?.trim()) updates.name = req.name.trim();
  if (req.prompt?.trim()) updates.prompt = req.prompt;
  if (req.schedule?.trim()) {
    updates.schedule = req.schedule.trim();
    updates.scheduleType = (req.scheduleType as ScheduleType) || job.scheduleType;
  }
  await store.updateJob(job.id, updates);
  process.emit("cron:refresh" as never);
  return { success: true, message: "updated" };
}

async function handleDeleteTask(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { id?: string };
  if (!req.id) return { success: false, message: "missing_id" };
  const userId = resolveMemoryUserId(ctx.userId);
  const store = new CronStore();
  const job = await store.getJob(req.id);
  if (!job || job.userId !== userId) return { success: false, message: "task_not_found" };
  await store.deleteJob(job.id);
  process.emit("cron:refresh" as never);
  return { success: true, message: "deleted" };
}

async function handleAnswerQuestion(
  deps: MobileApiDeps,
  call: grpc.ServerUnaryCall<unknown, unknown>,
  _ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { questionId?: string; answer?: string };
  if (!req.questionId || req.answer == null) return { success: false, message: "missing_args" };
  const ok = deps.getElicitationManager?.()?.resolveById(req.questionId, req.answer) ?? false;
  return ok
    ? { success: true, message: "answered" }
    : { success: false, message: "no_pending_question" };
}

// ──────────── Brain (knowledge graph + learned facts) ────────────

async function handleGetBrain(ctx: TenantContext): Promise<{
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    summary: string;
    degree: number;
    confidence: number;
  }>;
  edges: Array<{ src: string; dst: string; relation: string }>;
  facts: Array<{ text: string; source: string; confidence: number; learnedAt: string }>;
  entityCount: number;
  factCount: number;
}> {
  // The graph + user_model are already owner-scoped by the TenantContext.
  const overview = await getBrainOverview({
    orgId: ctx.orgId,
    userId: resolveMemoryUserId(ctx.userId),
  });
  return overview;
}

async function handleGetInbox(ctx: TenantContext) {
  return getInboxOverview({ orgId: ctx.orgId, userId: resolveMemoryUserId(ctx.userId) });
}

async function handleGetToday(ctx: TenantContext) {
  return getTodayOverview({ orgId: ctx.orgId, userId: resolveMemoryUserId(ctx.userId) });
}

// ──────────── Studio (hosted-only feature) ────────────
// Blobs move via presigned PUT/GET, never gRPC. Every handler is user_id-scoped
// through the authenticated TenantContext.

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: grpc.status.NOT_FOUND });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

async function handleStudioCreateAsset(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{
  assetId: string;
  uploadUrl: string;
  objectKey: string;
  expiresAt: number;
}> {
  const req = call.request as {
    mime?: string;
    contentHash?: string;
    width?: number;
    height?: number;
    bytes?: number;
  };
  const mime = req.mime || "image/jpeg";
  const ext = mime === "image/png" ? "png" : "jpg";
  // The object key must embed the asset's OWN id (not a throwaway uuid): a mask
  // uploaded via this same RPC is later passed back as `maskKey`, and the engine
  // resolves it by extracting `/studio/<id>/` and requiring getAsset(<id>) to
  // exist. A mismatched id is exactly what produced "invalid mask reference".
  const assetId = randomUUID();
  const key = objectKey("studio", assetId, `original.${ext}`);
  const asset = await createAsset(ctx, {
    id: assetId,
    objectKey: key,
    contentHash: req.contentHash ?? "",
    mime,
    width: req.width ?? null,
    height: req.height ?? null,
    bytes: req.bytes ?? 0,
  });
  const presigned = await getObjectStore().presignPut(key, { contentType: mime });
  return {
    assetId: asset.id,
    uploadUrl: presigned.url,
    objectKey: key,
    expiresAt: presigned.expiresAt,
  };
}

async function handleStudioGetAssetUrl(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ url: string; expiresAt: number }> {
  const req = call.request as { assetId?: string; original?: boolean };
  const assetId = req.assetId ?? "";
  if (!isUuid(assetId)) throw notFound("studio asset not found");
  const asset = await getAsset(ctx, assetId);
  if (!asset) throw notFound("studio asset not found");
  // The immutable original (before/after compare) vs the current head.
  let key = asset.objectKey;
  if (!req.original && asset.headEditId) {
    const head = await getEdit(ctx, asset.headEditId);
    if (head?.outputKey) key = head.outputKey;
  }
  const presigned = await getObjectStore().presignGet(key);
  return { url: presigned.url, expiresAt: presigned.expiresAt };
}

async function handleStudioEdit(
  call: grpc.ServerWritableStream<unknown, unknown>,
  ctx: TenantContext,
): Promise<void> {
  // Everything is inside try/finally so the stream ALWAYS ends cleanly (a thrown
  // getAsset/engine error emits an error event instead of destroying the stream).
  try {
    const req = call.request as {
      assetId?: string;
      op?: string;
      paramsJson?: string;
      parentEditId?: string;
      idempotencyKey?: string;
      maskKey?: string;
      inputImage?: Uint8Array;
    };
    const assetId = req.assetId ?? "";
    if (!isUuid(assetId)) {
      call.write({ kind: "error", message: "invalid asset id" });
      return;
    }
    // Inline device-render bytes are only valid for the deviceRender op, and are
    // capped well above a 4096px JPEG to keep the request bounded.
    const inputImage = req.inputImage && req.inputImage.length > 0 ? req.inputImage : null;
    if (inputImage && inputImage.length > 12 * 1024 * 1024) {
      call.write({ kind: "error", message: "input image too large" });
      return;
    }
    if (inputImage && req.op !== "deviceRender") {
      call.write({ kind: "error", message: "input_image is only valid for deviceRender" });
      return;
    }
    // A client-supplied mask must live under this tenant's object prefix; never
    // let a request read an arbitrary (or another tenant's) object as a mask.
    if (req.maskKey && !req.maskKey.startsWith(`org/${ctx.orgId}/`)) {
      call.write({ kind: "error", message: "invalid mask reference" });
      return;
    }
    let params: unknown = {};
    if (req.paramsJson) {
      try {
        params = JSON.parse(req.paramsJson);
      } catch {
        call.write({ kind: "error", message: "invalid params_json" });
        return;
      }
    }

    const asset = await getAsset(ctx, assetId);
    if (!asset) {
      call.write({ kind: "error", message: "studio asset not found" });
      return;
    }
    const parentEditId =
      req.parentEditId && req.parentEditId.length > 0 ? req.parentEditId : asset.headEditId;

    call.write({ kind: "progress", status: "running", message: `applying ${req.op ?? ""}` });
    try {
      // engine.edit confirms a pending asset, gates consent, and runs the op.
      const engine = buildStudioEngine();
      const edit = await engine.edit(ctx, {
        assetId: asset.id,
        op: { op: req.op ?? "", params },
        parentEditId,
        idempotencyKey: req.idempotencyKey || randomUUID(),
        maskKey: req.maskKey || null,
        inlineInputBytes: inputImage,
      });
      call.write({
        kind: "done",
        editId: edit.id,
        status: edit.status,
        previewKey: edit.previewKey ?? "",
        outputKey: edit.outputKey ?? "",
        costUsd: edit.costUsd,
      });
    } catch (err) {
      const message =
        err instanceof ConsentRequiredError
          ? "Cloud AI is turned off. Enable it in Studio settings to use this edit."
          : err instanceof StaleParentError
            ? "This photo changed since you started. Refresh and try again."
            : err instanceof Error
              ? err.message
              : String(err);
      call.write({ kind: "error", message });
    }
  } catch (err) {
    call.write({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    call.end();
  }
}

async function handleStudioHistory(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{
  edits: Array<{
    id: string;
    op: string;
    status: string;
    previewKey: string;
    outputKey: string;
    costUsd: number;
    parentEditId: string;
    createdAt: string;
  }>;
  headEditId: string;
}> {
  const assetId = (call.request as { assetId?: string }).assetId ?? "";
  if (!isUuid(assetId)) return { edits: [], headEditId: "" };
  const asset = await getAsset(ctx, assetId);
  // Fetching history means the client is using this asset; confirm it out of
  // `pending` so the orphan-upload GC sweep never reaps an in-use original.
  if (asset?.status === "pending") await confirmAsset(ctx, asset.id);
  const edits = await listEdits(ctx, assetId);
  return {
    edits: edits.map((e) => ({
      id: e.id,
      op: e.op,
      status: e.status,
      previewKey: e.previewKey ?? "",
      outputKey: e.outputKey ?? "",
      costUsd: e.costUsd,
      parentEditId: e.parentEditId ?? "",
      createdAt: e.createdAt.toISOString(),
    })),
    headEditId: asset?.headEditId ?? "",
  };
}

async function handleStudioListAssets(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{
  assets: Array<{
    assetId: string;
    previewUrl: string;
    updatedAt: number;
    finalized: boolean;
    editCount: number;
    headOp: string;
    expiresAt: number;
  }>;
}> {
  const limit = Number((call.request as { limit?: number }).limit ?? 0) || 30;
  const sessions = await listAssets(ctx, limit);
  const store = getObjectStore();
  const assets = await Promise.all(
    sessions.map(async (s) => {
      // Thumbnail: the head edit's ~256px preview, else its full output, else the original.
      const key = s.headPreviewKey ?? s.headOutputKey ?? s.objectKey;
      let previewUrl = "";
      let expiresAt = 0;
      try {
        const presigned = await store.presignGet(key);
        previewUrl = presigned.url;
        expiresAt = presigned.expiresAt;
      } catch {
        // A missing/unreadable object just yields no thumbnail; the card still lists.
      }
      return {
        assetId: s.id,
        previewUrl,
        updatedAt: s.updatedAt.getTime(),
        finalized: s.finalized,
        editCount: s.editCount,
        headOp: s.headOp ?? "",
        expiresAt,
      };
    }),
  );
  return { assets };
}

async function handleStudioSuggestEdits(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ suggestions: Array<{ label: string; prompt: string }> }> {
  const assetId = (call.request as { assetId?: string }).assetId ?? "";
  if (!isUuid(assetId)) return { suggestions: [] };
  // Analysis sends the photo to the cloud vision model, so it rides the SAME Cloud-AI
  // consent as editing. Off -> empty, and the client falls back to its static chips.
  if (!(await isCloudAIEnabled())) return { suggestions: [] };
  const asset = await getAsset(ctx, assetId);
  if (!asset) return { suggestions: [] };
  // Analyze the CURRENT head so the chips reflect the latest result, not the original.
  let key = asset.objectKey;
  if (asset.headEditId) {
    const head = await getEdit(ctx, asset.headEditId);
    if (head?.outputKey) key = head.outputKey;
  }
  let bytes: Uint8Array;
  try {
    bytes = await getObjectStore().get(key);
  } catch {
    return { suggestions: [] };
  }
  // Personalize: bias the suggestions toward the user's learned editing taste.
  const style = await readPhotoStyle(ctx.userId);
  const suggestions = await suggestEdits(bytes, asset.mime, { style: style || undefined });
  return { suggestions };
}

async function handleStudioReportIdentity(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  ctx: TenantContext,
): Promise<{ success: boolean; message: string }> {
  const req = call.request as { editId?: string; score?: number };
  const editId = req.editId ?? "";
  if (!isUuid(editId)) return { success: false, message: "invalid edit id" };
  const score = Math.max(0, Math.min(1, Number(req.score ?? 0)));
  const edit = await recordIdentityScore(ctx, editId, score);
  return edit
    ? { success: true, message: "recorded" }
    : { success: false, message: "edit not found" };
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
