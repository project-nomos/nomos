/**
 * Agent eval: end-to-end checks of the memory + session management system, in
 * BOTH power-user and hosted modes, plus a live MobileApi wire test and an
 * LLM-as-a-Judge pass on recall quality.
 *
 * What it covers:
 *  - memory recall (vault) + a judge verdict on whether recall answers the query
 *  - the mode contract of resolveMemoryUserId: power-user collapses every channel
 *    to one owner; hosted keeps users isolated (no cross-user leak)
 *  - per-user isolation across vault + memory_chunks + user_model + contacts
 *  - session management: continuity (resume by key) + ephemeral (off-the-record)
 *  - the mobile endpoints over the Connect wire (write/list/get/delete vault)
 *  - the AUTHENTICATED hosted wire: minted JWTs prove per-tenant isolation +
 *    reject unauthenticated calls
 *  - a live agent conversation over the gRPC NomosAgent.Chat RPC (judged recall)
 *  - the JWT-gated streaming MobileApi.Chat with a REAL nomos-server token (judged
 *    recall); skipped when nomos-server is not running
 *  - derived stores built from the vault: the knowledge graph (kg_nodes/kg_edges),
 *    the wiki (wiki_articles), and auto-dream consolidation -- each per-user scoped
 *  - transcript_messages persistence (non-ephemeral turns only)
 *
 * It runs against a freshly provisioned, throwaway database (nomos_eval) that is
 * dropped on exit, so it never touches the dev `nomos` DB.
 *
 * The `--audit` modes add two model-graded audits over the just-written DB (see the
 * Audits section of eval/README.md):
 *  - the LABEL audit (Opus-4.8 / xhigh): confirms the rows back the passing test labels
 *  - the SPEC audit (runSpecAudit): reasons against eval/feature-manifest.ts -- liveness
 *    (every feature has a live caller), a cron sentinel meta-check, per-feature effect SQL
 *    + jsonb double-encode guards, and an Opus-4.8 reasoning pass. This is what makes an
 *    unwired or under-populated feature fail; declare new features in the manifest.
 *
 * Run:  DATABASE_URL=... [NOMOS_USE_SUBSCRIPTION=true] pnpm eval:agent
 *   pnpm eval:agent            fast deterministic + judged checks, drops the DB
 *   pnpm eval:audit            ^ + the label audit AND the spec/manifest audit
 *                              (eval -> audit -> clean, all in one run)
 *   pnpm eval:agent --keep     keep nomos_eval for inspection
 *   pnpm eval:agent --audit-kept   audit a kept DB (label + spec) without re-running the eval
 *   pnpm eval:agent --clean    drop a kept nomos_eval
 * Exits non-zero on any failure. Judge + real-token checks skip (reported) when no
 * LLM provider / no nomos-server is available.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { config } from "dotenv";
// Load .env the same way the app entry point does, so DATABASE_URL and the LLM
// provider key are present when this script runs standalone (the judge runs only
// when a provider is configured).
config({ path: [".env.local", ".env"], quiet: true });
config({
  path: [join(homedir(), ".nomos", ".env.local"), join(homedir(), ".nomos", ".env")],
  quiet: true,
});

import postgres from "postgres";
import { sql } from "kysely";
import { ConnectError, Code } from "@connectrpc/connect";
import { closeDb, getKysely } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createDatabase, dropDatabase, withDatabaseName } from "../src/db/migrator.ts";
import { resolveMemoryUserId } from "../src/auth/tenant-context.ts";
import { vaultWrite, vaultSearch, vaultRead, vaultDelete } from "../src/memory/vault.ts";
import {
  storeMemoryChunk,
  searchMemoryByText,
  searchMemoryByCategory,
  recordMemoryAccess,
  deleteMemoryByPath,
} from "../src/db/memory.ts";
import { createContact, listContacts, mergeContacts } from "../src/identity/contacts.ts";
import { resolveContact, listIdentities } from "../src/identity/identities.ts";
import { refreshRelationshipStats } from "../src/identity/relationship.ts";
import { embedMissingNodes, materializeSemanticEdges } from "../src/memory/graph-semantic.ts";
import { isEmbeddingAvailable } from "../src/memory/embeddings.ts";
import { runAutoLinker } from "../src/identity/auto-linker.ts";
import {
  createSession,
  getSessionByKey,
  updateSessionSdkId,
  updateSessionModelByKey,
} from "../src/db/sessions.ts";
import { getVaultNote } from "../src/db/vault.ts";
import {
  markMagicDocUpdated,
  isMagicDocStale,
  writeMagicDoc,
  refreshMagicDocs,
} from "../src/memory/magic-docs.ts";
import { SessionStore } from "../src/sessions/store.ts";
import { CronStore } from "../src/cron/store.ts";
import { curateConsumerTasks } from "../src/cron/task-view.ts";
import {
  createDraft,
  getDraft,
  listPendingDrafts,
  approveDraft,
  rejectDraft,
  markDraftSent,
} from "../src/db/drafts.ts";
import { syncFileToDb } from "../src/config/file-sync.ts";
import {
  countTranscriptMessages,
  appendTranscriptMessage,
  getTranscriptWithUsage,
} from "../src/db/transcripts.ts";
import {
  backfillGraph,
  getProjection,
  neighborhood,
  getNodeByExternal,
  upsertNode,
  upsertEdge,
  mergeNodeAttrs,
  getNode,
} from "../src/memory/graph.ts";
import { consolidateMemory } from "../src/memory/consolidator.ts";
import {
  autoDream,
  getConsolidationState,
  shouldConsolidate,
  runAutoDreamCycle,
  reRankValues,
} from "../src/memory/auto-dream.ts";
import {
  storeCommitments,
  getPendingCommitments,
  getCommitmentsForReminder,
} from "../src/proactive/commitment-tracker.ts";
import { compileKnowledge } from "../src/memory/knowledge-compiler.ts";
import { listArticles, upsertArticle, searchArticles, getArticle } from "../src/db/wiki.ts";
import { getRelevantArticles } from "../src/memory/wiki-reader.ts";
import { runForkedAgent } from "../src/sdk/forked-agent.ts";
import { isEphemeralSession, indexConversationTurn } from "../src/daemon/memory-indexer.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";
import type { AgentEvent, IncomingMessage, OutgoingMessage } from "../src/daemon/types.ts";
import { refreshJwks } from "../src/auth/jwt-validator.ts";
import { judge } from "./judge.ts";
import { FEATURES } from "./feature-manifest.ts";
import { startWire, startConnectServer, makeMobileClient } from "./wire.ts";
import { startHostedAuth } from "./hosted-auth.ts";
import { provisionRealUser } from "./nomos-server-auth.ts";

// The judge needs any provider the forked-agent path supports: a direct API key,
// Vertex, or a Claude subscription (NOMOS_USE_SUBSCRIPTION).
const hasLLM =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
  process.env.NOMOS_USE_SUBSCRIPTION === "true";

// `--audit` (the default `pnpm eval:audit`) runs the full eval, then an
// Opus-4.8 / xhigh ("ultracode") pass that inspects the ACTUAL nomos_eval content
// and cross-checks it against the deterministic test results -- all in ONE run
// (eval -> audit -> clean). It catches false-passes the boolean assertions can't
// (e.g. double-encoded jsonb). It needs the rows present, so it skips per-test
// cleanup. `--audit-kept` instead audits a DB a prior `--keep` run left behind
// (no eval re-run), for inspect-then-audit.
const AUDIT_KEPT = process.argv.slice(2).includes("--audit-kept");
const AUDIT = process.argv.slice(2).includes("--audit") || AUDIT_KEPT;

// Skip per-test cleanup so the audit (or a manual inspector) sees the rows.
const KEEP = process.argv.slice(2).includes("--keep") || AUDIT;

interface Result {
  label: string;
  pass: boolean;
  skipped?: boolean;
  note?: string;
}
const results: Result[] = [];

function check(label: string, pass: boolean, note?: string): void {
  results.push({ label, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${note ? `  (${note})` : ""}`);
}
function skip(label: string, note: string): void {
  results.push({ label, pass: true, skipped: true, note });
  // eslint-disable-next-line no-console
  console.log(`SKIP  ${label}  (${note})`);
}

function setMode(mode: "power_user" | "hosted"): void {
  if (mode === "hosted") {
    process.env.NOMOS_MODE = "hosted";
    process.env.NOMOS_ORG_ID = "eval-org";
  } else {
    delete process.env.NOMOS_MODE;
    delete process.env.NOMOS_ORG_ID;
  }
}

async function runMode(mode: "power_user" | "hosted"): Promise<void> {
  setMode(mode);
  // Two distinct raw "channel/user" ids. In power-user they must collapse to one
  // owner; in hosted they must stay separate.
  const rawA = "eval-alice";
  const rawB = "eval-bob";
  const ua = resolveMemoryUserId(rawA);
  const ub = resolveMemoryUserId(rawB);

  // Uniquely-namespaced test artifacts. In power-user mode the owner IS the real
  // `local` brain, so everything is scoped under an `eval-tmp/` path + `eval_tmp`
  // keys and torn down surgically (never a bulk delete of the owner's rows).
  const notePath = "eval-tmp/facts.md";
  const chunkId = `eval-tmp:${ua}:c1`;
  const modelKey = "eval_tmp_editor";

  // ── mode contract ──
  if (mode === "power_user") {
    check("[power_user] both channels collapse to one owner", ua === ub && ua === "local");
  } else {
    check("[hosted] distinct users stay distinct owners", ua === rawA && ub === rawB && ua !== ub);
  }

  // ── memory recall + judge ──
  await vaultWrite(ua, notePath, "The user's dentist is Dr. Patel at 5th Avenue Dental.");
  const recalled = await vaultSearch(ua, "who is my dentist");
  const recalledText = recalled.map((n) => n.content).join("\n");
  check(`[${mode}] vault recall returns the seeded fact`, recalledText.includes("Patel"));

  if (hasLLM) {
    const v = await judge({
      context: "The user asked their assistant: who is my dentist?",
      response: recalledText || "(nothing recalled)",
      rubric: "A passing response must contain the dentist's name (Dr. Patel).",
    });
    check(`[${mode}] judge: recalled memory answers the question`, v.pass, v.reasoning);
  } else {
    skip(`[${mode}] judge: recalled memory answers the question`, "no LLM provider configured");
  }

  // ── isolation / collapse contract across stores ──
  await storeMemoryChunk({
    id: chunkId,
    userId: ua,
    source: "conversation",
    text: "eval-tmp apollo",
  });
  await upsertModel(ua, modelKey, "vim");
  const contact = await createContact(ua, { displayName: "Eval Tmp Contact" });

  if (mode === "hosted") {
    // B must see none of A's data.
    check("[hosted] vault: B cannot read A's note", (await vaultRead(ub, notePath)) === null);
    check(
      "[hosted] chunks: B FTS excludes A",
      (await searchMemoryByText(ub, "apollo")).every((r) => !r.text.includes("eval-tmp")),
    );
    check(
      "[hosted] contacts: B lists none of A's",
      (await listContacts(ub)).every((c) => c.user_id === ub),
    );
  } else {
    // Power-user: B is the same owner, so it SEES A's note (one brain).
    check(
      "[power_user] vault: same-owner read sees the note",
      (await vaultRead(ub, notePath))?.content.includes("Patel") === true,
    );
  }

  // ── sessions ──
  const skey = `eval:${mode}:s1`;
  await createSession({ sessionKey: skey });
  check(`[${mode}] session continuity: resume by key`, (await getSessionByKey(skey)) !== null);
  check(
    `[${mode}] ephemeral session is detected (off-the-record)`,
    isEphemeralSession("mobile:ephemeral:abc") && !isEphemeralSession(skey),
  );

  // ── cleanup for this mode (surgical for the real local owner; bulk only for
  // the synthetic hosted tenants, which never hold real data). Skipped under
  // --keep so the rows stay inspectable. ──
  if (KEEP) return;
  if (mode === "power_user") {
    await purgeArtifacts(ua, { notePath, chunkId, modelKey, contactId: contact.id });
  } else {
    await purgeSyntheticTenant(ua);
    await purgeSyntheticTenant(ub);
  }
  await getKysely().deleteFrom("sessions").where("session_key", "=", skey).execute();
}

async function runWire(): Promise<void> {
  // Mobile endpoints over the real Connect wire, power-user (LOCAL_TENANT, no JWT).
  setMode("power_user");
  const notePath = "eval-tmp/wire-note.md";
  const wire = await startWire();
  try {
    await wire.client.writeVaultNote({
      path: notePath,
      content: "wire endpoint content",
      title: "Wire",
    });
    const list = await wire.client.listVaultNotes({});
    check(
      "[wire] WriteVaultNote + ListVaultNotes round-trip",
      list.notes.some((n) => n.path === notePath),
    );
    const got = await wire.client.getVaultNote({ path: notePath });
    check(
      "[wire] GetVaultNote returns the written content",
      got.exists && got.content.includes("wire endpoint"),
    );
    const del = await wire.client.deleteVaultNote({ path: notePath });
    check("[wire] DeleteVaultNote succeeds", del.success !== false);
    const after = await wire.client.getVaultNote({ path: notePath });
    check("[wire] note is gone after delete", after.exists === false);
  } finally {
    await wire.stop();
    // Surgical: only the test note (+ its fire-and-forget vector chunk), never a
    // bulk delete of the real local owner. Skipped under --keep.
    if (!KEEP) await purgeArtifacts("local", { notePath });
  }
}

async function runHostedWire(): Promise<void> {
  // GAP 1: the mobile endpoints over the AUTHENTICATED hosted wire. Two tenants
  // with minted JWTs hit the same live MobileApi server; isolation is proven over
  // the wire (auth -> resolveContext -> per-user handler), not just at the store.
  const auth = await startHostedAuth("eval-org");
  const ids = ["eval-alice", "eval-bob"];
  await seedOrgMembers(ids);
  const server = await startConnectServer();
  const alice = makeMobileClient(server.port, () => auth.mint("eval-alice"));
  const bob = makeMobileClient(server.port, () => auth.mint("eval-bob"));
  const anon = makeMobileClient(server.port); // no bearer
  try {
    await alice.writeVaultNote({
      path: "hw/secret.md",
      content: "alice hosted-wire secret",
      title: "Secret",
    });

    const aList = await alice.listVaultNotes({});
    check(
      "[hosted-wire] author lists own note (authenticated)",
      aList.notes.some((n) => n.path === "hw/secret.md"),
    );

    const bList = await bob.listVaultNotes({});
    check(
      "[hosted-wire] other tenant cannot list author's note",
      !bList.notes.some((n) => n.path === "hw/secret.md"),
    );

    const bGet = await bob.getVaultNote({ path: "hw/secret.md" });
    check("[hosted-wire] other tenant cannot read author's note", bGet.exists === false);

    let rejected = false;
    try {
      await anon.listVaultNotes({});
    } catch (err) {
      rejected = err instanceof ConnectError && err.code === Code.Unauthenticated;
    }
    check("[hosted-wire] unauthenticated call is rejected at the wire", rejected);
  } finally {
    await server.stop();
    if (!KEEP) {
      await removeOrgMembers(ids);
      for (const id of ids) await purgeSyntheticTenant(id);
    }
    await auth.stop();
  }
}

async function runGrpcChat(): Promise<void> {
  // GAP 2: a live multi-turn agent conversation over the real gRPC Chat RPC.
  // Boot GrpcServer + MessageQueue + AgentRuntime (power-user; NomosAgent.Chat is
  // unauthenticated and resolves to the local owner), drive two turns on one
  // session, and judge whether turn 2 recalls turn 1.
  delete process.env.NOMOS_MODE;
  delete process.env.NOMOS_ORG_ID;
  delete process.env.AUTH_JWKS_URL;
  if (!hasLLM) {
    skip("[grpc-chat] agent recalls a fact across turns over gRPC", "no LLM provider configured");
    skip("[grpc-chat] judge: agent answer recalls the fact", "no LLM provider configured");
    return;
  }

  // An `ephemeral` segment in the derived session key skips automatic capture, so
  // the live turns do not pollute the local vault; recall rides the SDK buffer.
  const chatChannel = "ephemeral:eval-chat";
  const dbSessionKey = `terminal:${chatChannel}`;
  let server: GrpcServer | undefined;
  let client: GrpcClient | undefined;
  try {
    const runtime = new AgentRuntime();
    await runtime.initialize();
    const queue = new MessageQueue((msg, emit) => runtime.processMessage(msg, emit));
    server = new GrpcServer(queue, 18766);
    await server.start();
    client = new GrpcClient({ port: 18766, autoReconnect: false });
    await client.connect();

    await sendAndWait(
      client,
      "Please remember this for later: my dentist is Dr. Patel on 5th Avenue. Just acknowledge.",
      chatChannel,
      120_000,
    );
    const answer = await sendAndWait(
      client,
      "Who is my dentist? Reply with just the name.",
      chatChannel,
      120_000,
    );

    check(
      "[grpc-chat] agent recalls a fact across turns over gRPC",
      answer.includes("Patel"),
      answer.slice(0, 100),
    );
    const v = await judge({
      context:
        "Across two chat turns the user said their dentist is Dr. Patel, then asked who their dentist is.",
      response: answer,
      rubric:
        "A passing response must name the dentist as Dr. Patel (the surname Patel is sufficient).",
    });
    check("[grpc-chat] judge: agent answer recalls the fact", v.pass, v.reasoning);

    // transcript_messages: a NON-ephemeral turn must persist user+assistant rows;
    // the ephemeral turns above must NOT. Persistence is fire-and-forget, so poll.
    await sendAndWait(
      client,
      "Remember: the sky is teal today. Just acknowledge.",
      "eval-transcript",
      120_000,
    );
    let tCount = 0;
    for (let i = 0; i < 25 && tCount < 2; i++) {
      const s = await getSessionByKey("terminal:eval-transcript");
      if (s) tCount = await countTranscriptMessages(s.id);
      if (tCount < 2) await new Promise((r) => setTimeout(r, 200));
    }
    check("[transcript] a non-ephemeral turn persists user+assistant rows", tCount >= 2);
    const es = await getSessionByKey(dbSessionKey);
    const eCount = es ? await countTranscriptMessages(es.id) : 0;
    check("[transcript] ephemeral session is NOT transcribed (off-the-record)", eCount === 0);
  } catch (err) {
    check(
      "[grpc-chat] agent recalls a fact across turns over gRPC",
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    try {
      client?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await server?.stop();
    } catch {
      /* ignore */
    }
    if (!KEEP) {
      await getKysely()
        .deleteFrom("sessions")
        .where("session_key", "=", dbSessionKey)
        .execute()
        .catch(() => undefined);
    }
  }
}

/** Send one Chat turn and resolve with the final assistant text (the "result" event). */
function sendAndWait(
  client: GrpcClient,
  content: string,
  sessionKey: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("chat turn timed out"))),
      timeoutMs,
    );
    const unsub = client.onEvent((ev: AgentEvent) => {
      if (ev.type === "result") finish(() => resolve(ev.result ?? ""));
      else if (ev.type === "error") finish(() => reject(new Error(ev.message)));
    });
    client.sendMessage(content, sessionKey);
  });
}

async function runHostedMobileChat(): Promise<void> {
  // GAP 2 (full fidelity): the JWT-gated streaming MobileApi.Chat RPC, driven with
  // a REAL token issued by nomos-server (Better Auth), verified against its live
  // JWKS. Skips when nomos-server is not running, so the eval stays standalone.
  const label = "[mobile-chat] authenticated MobileApi.Chat recalls across turns (real token)";
  const judgeLabel = "[mobile-chat] judge: authenticated agent answer recalls the fact";
  if (!hasLLM) {
    skip(label, "no LLM provider configured");
    skip(judgeLabel, "no LLM provider configured");
    return;
  }
  const real = await provisionRealUser();
  if (!real) {
    skip(label, "nomos-server not reachable on :4000");
    skip(judgeLabel, "nomos-server not reachable on :4000");
    return;
  }

  process.env.NOMOS_MODE = "hosted";
  process.env.NOMOS_ORG_ID = real.orgId;
  process.env.AUTH_JWKS_URL = `${real.serverUrl}/api/auth/jwks`;
  await refreshJwks().catch(() => undefined); // fetch nomos-server's real keys
  await seedOrgMembers([real.userId]); // interceptor gates on membership

  const chatChannel = "ephemeral:eval-mobile";
  let runtime: AgentRuntime | undefined;
  let server: Awaited<ReturnType<typeof startConnectServer>> | undefined;
  try {
    runtime = new AgentRuntime();
    await runtime.initialize();
    const queue = new MessageQueue((msg, emit) => runtime!.processMessage(msg, emit));
    server = await startConnectServer(undefined, queue);
    const client = makeMobileClient(server.port, () => real.token);

    await mobileChatTurn(
      client,
      "Please remember this for later: my dentist is Dr. Patel on 5th Avenue. Just acknowledge.",
      chatChannel,
    );
    const answer = await mobileChatTurn(
      client,
      "Who is my dentist? Reply with just the name.",
      chatChannel,
    );

    check(label, answer.includes("Patel"), answer.slice(0, 100));
    const v = await judge({
      context:
        "Over two authenticated mobile chat turns the user said their dentist is Dr. Patel, then asked who their dentist is.",
      response: answer,
      rubric:
        "A passing response must name the dentist as Dr. Patel (the surname Patel is sufficient).",
    });
    check(judgeLabel, v.pass, v.reasoning);
  } catch (err) {
    check(label, false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      await server?.stop();
    } catch {
      /* ignore */
    }
    delete process.env.NOMOS_MODE;
    delete process.env.NOMOS_ORG_ID;
    delete process.env.AUTH_JWKS_URL;
    await refreshJwks().catch(() => undefined);
  }
}

/** Drive one MobileApi.Chat server-streaming turn; return the final assistant text. */
async function mobileChatTurn(
  client: ReturnType<typeof makeMobileClient>,
  content: string,
  sessionKey: string,
): Promise<string> {
  let finalText = "";
  for await (const ev of client.chat({ content, sessionKey }, { timeoutMs: 120_000 })) {
    if (ev.type === "result") {
      const payload = ev.jsonPayload ? (JSON.parse(ev.jsonPayload) as { result?: string }) : {};
      finalText = payload.result ?? "";
    } else if (ev.type === "error") {
      const payload = ev.jsonPayload ? (JSON.parse(ev.jsonPayload) as { message?: string }) : {};
      throw new Error(payload.message ?? "agent error");
    }
  }
  return finalText;
}

// Hosted Google OAuth: the deposit's canonical storage shape (the bug that made a
// connected account invisible to the MCP read path), per-user isolation, refresh
// reuse, official-MCP registration, connected vs not-connected guidance, and the
// malformed-row dedup migration. Leaves the canonical row in place so the spec
// audit's effect SQL can observe it; the throwaway DB is dropped afterward.
async function runGoogleAuth(): Promise<void> {
  const { storeGoogleAccount, listGoogleAccounts, getValidAccessToken } =
    await import("../src/auth/google-integration.ts");
  const { buildGoogleMcpServers, buildGoogleIntegrationPrompt } =
    await import("../src/sdk/google-mcp.ts");
  const { upsertIntegration } = await import("../src/db/integrations.ts");

  // Force the official (hosted) backend with creds present so the registration path
  // runs regardless of NOMOS_MODE. A non-expired token means getValidAccessToken
  // never refreshes, so the dummy creds never hit Google.
  const saved = {
    backend: process.env.NOMOS_GOOGLE_BACKEND,
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.NOMOS_GOOGLE_BACKEND = "official";
  process.env.GOOGLE_CLIENT_ID ??= "eval-dummy-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "eval-dummy-secret";

  const uA = "eval-gauth-a";
  const uB = "eval-gauth-b";
  const email = "alice@example.com";
  const future = Math.floor(Date.now() / 1000) + 3600;
  const db = getKysely();

  try {
    await storeGoogleAccount({
      userId: uA,
      email,
      tokens: {
        accessToken: "at-eval",
        refreshToken: "rt-eval",
        expiresAt: future,
        scope: "calendar",
      },
      scopes: "calendar gmail drive",
    });

    const names = (
      await db.selectFrom("integrations").select("name").where("name", "like", "google:%").execute()
    ).map((r) => r.name);
    check(
      "[google] deposited as canonical google:{userId}:{email} (the MCP read-path prefix)",
      names.includes(`google:${uA}:${email}`),
    );

    const accountsA = await listGoogleAccounts(uA);
    check(
      "[google] listGoogleAccounts returns the connected account as default",
      accountsA.length === 1 && accountsA[0]!.email === email && accountsA[0]!.isDefault,
    );
    check(
      "[google] account is user-scoped (B sees none of A's)",
      (await listGoogleAccounts(uB)).length === 0,
    );

    check(
      "[google] getValidAccessToken returns the stored token (refresh reuse, no re-auth)",
      (await getValidAccessToken(uA, email)) === "at-eval",
    );

    const keys = Object.keys(await buildGoogleMcpServers(uA));
    check(
      "[google] connected → official MCP registers gmail+calendar+drive",
      keys.includes("google-gmail") &&
        keys.includes("google-calendar") &&
        keys.includes("google-drive"),
    );

    const notConnected = await buildGoogleIntegrationPrompt(uB, false);
    check(
      "[google] not-connected prompt says reconnect in Settings (no browser/flailing)",
      /not connected/i.test(notConnected) && /Settings/.test(notConnected),
    );
    check(
      "[google] connected prompt asserts active access",
      /Connected Google accounts/.test(await buildGoogleIntegrationPrompt(uA, true)),
    );

    // Malformed pre-fix row (google:{userId}, no :email) — invisible to listGoogleAccounts,
    // showed as a phantom Settings duplicate. The dedup migration must drop it + keep canonical.
    await upsertIntegration(`google:${uA}`, { enabled: true, config: { provider: "google" } });
    await db
      .deleteFrom("integrations")
      .where("name", "like", "google:%")
      .where("name", "not like", "google:%:%")
      .execute();
    const after = (
      await db
        .selectFrom("integrations")
        .select("name")
        .where("name", "like", `google:${uA}%`)
        .execute()
    ).map((r) => r.name);
    check(
      "[google] dedup drops malformed google:{userId}, keeps canonical",
      after.length === 1 && after[0] === `google:${uA}:${email}`,
    );
  } finally {
    process.env.NOMOS_GOOGLE_BACKEND = saved.backend;
    if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
  }
}

async function runGraphBuild(): Promise<void> {
  // Derived store: kg_nodes / kg_edges are built FROM the vault by backfillGraph
  // (deterministic, no LLM). Asserts the derive-from-vault pipeline + closes the
  // kg_* per-user isolation gap (check:isolation does not cover the graph).
  const ctxA = { orgId: "eval-org", userId: "eval-graph-a" };
  const ctxB = { orgId: "eval-org", userId: "eval-graph-b" };

  await createContact(ctxA.userId, { displayName: "Alice Chen" });
  await vaultWrite(ctxA.userId, "people/alice.md", "Alice works with [[Bob]].", { title: "Alice" });
  await vaultWrite(ctxA.userId, "people/bob.md", "Bob notes.", { title: "Bob" });
  await createContact(ctxB.userId, { displayName: "Carol Roe" });
  await vaultWrite(ctxB.userId, "people/carol.md", "Carol's private note.", { title: "Carol" });

  const rA = await backfillGraph(ctxA);
  await backfillGraph(ctxB);

  check(
    "[graph] backfill promotes vault notes + contacts into kg_nodes",
    rA.vaultNodes >= 2 && rA.personNodes >= 1,
  );
  check("[graph] backfill creates [[link]] edges (kg_edges)", rA.linkEdges >= 1);

  const projA = await getProjection(ctxA, { limit: 500 });
  check(
    "[graph] projection returns A's nodes (person + vault kinds)",
    projA.nodes.some((n) => n.kind === "person") &&
      projA.nodes.filter((n) => n.kind === "vault").length >= 2,
  );
  check(
    "[graph] projection includes a links_to edge",
    projA.edges.some((e) => e.relType === "links_to"),
  );

  const projB = await getProjection(ctxB, { limit: 500 });
  check(
    "[graph] B's projection excludes A's nodes",
    projB.nodes.every((n) => n.name !== "Alice Chen"),
  );
  const aNodeId = projA.nodes[0]?.id;
  const cross = aNodeId
    ? await neighborhood(ctxB, aNodeId, { depth: 3 })
    : { nodes: [], edges: [] };
  check(
    "[graph] traversal cannot cross tenants",
    cross.nodes.length === 0 && cross.edges.length === 0,
  );
  check(
    "[graph] getNodeByExternal is owner-scoped",
    (await getNodeByExternal(ctxB, "vault", "people/alice.md")) === undefined,
  );

  // Newly wired: backfill now gives vault/wiki nodes a summary from their body.
  const db = getKysely();
  const sumRow = await db
    .selectFrom("kg_nodes")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", ctxA.userId)
    .where("external_kind", "=", "vault")
    .where("summary", "is not", null)
    .executeTakeFirst();
  check("[graph] vault nodes get a summary from their note body", Number(sumRow?.n) >= 2);

  // Newly wired: embedMissingNodes populates kg_nodes.embedding (was always null,
  // leaving the HNSW index dead) + materializeSemanticEdges builds meaning edges.
  if (isEmbeddingAvailable()) {
    const emb = await embedMissingNodes(ctxA);
    check("[graph] embedMissingNodes embeds nodes that lacked an embedding", emb.embedded >= 1);
    const embRow = await db
      .selectFrom("kg_nodes")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", ctxA.userId)
      .where("embedding", "is not", null)
      .executeTakeFirst();
    check(
      "[graph] kg_nodes.embedding is populated (vector index now live)",
      Number(embRow?.n) >= 1,
    );
    const sem = await materializeSemanticEdges(ctxA);
    check("[graph] materializeSemanticEdges runs over the embedded nodes", sem.nodes >= 1);
  } else {
    skip(
      "[graph] embedMissingNodes embeds nodes that lacked an embedding",
      "no embedding provider",
    );
  }
}

async function runConsolidation(): Promise<void> {
  // Auto-dream's per-user worker (consolidateMemory). Phase-1 prune is
  // deterministic (no LLM). Assert it prunes stale chunks AND stays scoped to one
  // user. (The gated/leased autoDream wrapper is dormant; this is the real path.)
  const A = "eval-dream-a";
  const B = "eval-dream-b";
  const db = getKysely();
  for (const u of [A, B]) {
    await storeMemoryChunk({
      id: `dream:${u}:stale`,
      userId: u,
      source: "conversation",
      text: "stale trivia that should be pruned",
      metadata: { category: "fact" },
    });
  }
  // Backdate so the age (>7d) + low-access prune predicate matches.
  await db
    .updateTable("memory_chunks")
    .set({ created_at: sql`now() - interval '30 days'`, access_count: 0, last_accessed_at: null })
    .where("id", "in", [`dream:${A}:stale`, `dream:${B}:stale`])
    .execute();

  // Phase 4: confidence decay for a user_model row untouched for >30 days.
  await upsertModel(A, "stale_pref", "old-value");
  await db
    .updateTable("user_model")
    .set({ updated_at: sql`now() - interval '40 days'` })
    .where("user_id", "=", A)
    .where("key", "=", "stale_pref")
    .execute();

  const result = await consolidateMemory(A);
  check(
    "[auto-dream] consolidation prunes stale chunks",
    result.pruned >= 1 && result.totalAfter < result.totalBefore,
  );
  const aGone = await db
    .selectFrom("memory_chunks")
    .select("id")
    .where("id", "=", `dream:${A}:stale`)
    .executeTakeFirst();
  const bSurvives = await db
    .selectFrom("memory_chunks")
    .select("id")
    .where("id", "=", `dream:${B}:stale`)
    .executeTakeFirst();
  check("[auto-dream] A's stale chunk is pruned", !aGone);
  check("[auto-dream] consolidation stayed scoped to A (B untouched)", Boolean(bSurvives));

  const decayed = await db
    .selectFrom("user_model")
    .select("confidence")
    .where("user_id", "=", A)
    .where("key", "=", "stale_pref")
    .executeTakeFirst();
  check(
    "[auto-dream] stale user_model confidence decays (Phase 4)",
    decayed != null && Number(decayed.confidence) < 0.9 && Number(decayed.confidence) >= 0.1,
  );
}

async function runAutoDreamState(): Promise<void> {
  // The autoDream() orchestrator persists a singleton run-state row
  // (instance-wide). Gates: turn delta >= 10, time gate skipped on fresh state;
  // the Redis lease no-ops without REDIS_URL. Asserts the state IS written, that
  // the run outcome round-trips through state_json as an OBJECT (not a
  // double-encoded JSON string), and that the gate then blocks a premature re-run.
  const db = getKysely();
  await db.deleteFrom("auto_dream_state").execute();
  const result = { merged: 2, pruned: 1, newChunks: 3, durationMs: 0 };
  const run = async () => ({ ...result });

  const ran = await autoDream(10, run);
  check("[auto-dream-state] autoDream runs when the turn gate is met", ran !== null);
  const state = await getConsolidationState();
  check(
    "[auto-dream-state] run-state is persisted (last_run_at + turn count + total_runs)",
    Boolean(state.lastRunAt) && state.lastTurnCount === 10 && state.totalRuns === 1,
  );
  // state_json round-trips as a readable object (the recurring jsonb
  // double-encoding bug would surface it as a string here).
  check(
    "[auto-dream-state] state_json round-trips as an object {merged,pruned,newChunks}",
    typeof state.lastResult === "object" &&
      state.lastResult !== null &&
      (state.lastResult as Record<string, unknown>).merged === 2 &&
      (state.lastResult as Record<string, unknown>).pruned === 1 &&
      (state.lastResult as Record<string, unknown>).newChunks === 3,
  );
  const raw = await db
    .selectFrom("auto_dream_state")
    .select("state_json")
    .where("id", "=", 1)
    .executeTakeFirst();
  check(
    "[auto-dream-state] state_json column is jsonb object, not a double-encoded string",
    raw != null && typeof raw.state_json === "object" && raw.state_json !== null,
  );
  const blocked = await autoDream(10, run);
  check("[auto-dream-state] gate blocks a re-run without 10 new turns", blocked === null);

  // The production cron entry point runs the same singleton gate, so right after
  // a successful run it must no-op (returns null) without fanning out to any
  // per-owner consolidation. Deterministic: the time gate is still fresh.
  const gated = await runAutoDreamCycle();
  check(
    "[auto-dream-state] runAutoDreamCycle respects the time gate (no-op after a run)",
    gated === null,
  );
}

async function runQuickFixWiring(): Promise<void> {
  // Deterministic coverage (no LLM) for the partial-feature fixes:
  // smart-routed model persistence, ingest delta_schedule default contract, and
  // (the important one) reRankValues owner-scoping.
  const db = getKysely();
  const { upsertUserModel, getUserModel } = await import("../src/db/user-model.ts");

  // ── routed-model persistence (updateSessionModelByKey) ──
  const rKey = "terminal:eval-routemodel";
  await db.deleteFrom("sessions").where("session_key", "=", rKey).execute();
  await createSession({ sessionKey: rKey, model: "claude-haiku-4-5", metadata: {} });
  await updateSessionModelByKey(rKey, "claude-opus-4-8");
  check(
    "[quickfix] updateSessionModelByKey persists the routed model by session_key",
    (await getSessionByKey(rKey))?.model === "claude-opus-4-8",
  );

  // ── ingest delta_schedule: omitted -> DB DEFAULT '6h'; explicit -> stored ──
  await db
    .deleteFrom("ingest_jobs")
    .where("platform", "in", ["eval-delta-a", "eval-delta-b"])
    .execute();
  await db
    .insertInto("ingest_jobs")
    .values({ platform: "eval-delta-a", source_type: "x", status: "running" })
    .execute();
  await db
    .insertInto("ingest_jobs")
    .values({ platform: "eval-delta-b", source_type: "x", status: "running", delta_schedule: "1h" })
    .execute();
  const defRow = await db
    .selectFrom("ingest_jobs")
    .select("delta_schedule")
    .where("platform", "=", "eval-delta-a")
    .executeTakeFirst();
  const setRow = await db
    .selectFrom("ingest_jobs")
    .select("delta_schedule")
    .where("platform", "=", "eval-delta-b")
    .executeTakeFirst();
  check(
    "[quickfix] omitting delta_schedule falls back to the DB default '6h'",
    defRow?.delta_schedule === "6h",
  );
  check("[quickfix] explicit delta_schedule round-trips", setRow?.delta_schedule === "1h");

  // ── reRankValues owner-scoping (the tenant-correctness fix) ──
  const aId = "eval-rerank-a";
  const bId = "eval-rerank-b";
  for (const uid of [aId, bId]) {
    await db.deleteFrom("user_model").where("user_id", "=", uid).execute();
    await upsertUserModel({
      userId: uid,
      category: "value",
      key: "ship_fast",
      value: { value: "ship fast" },
      sourceIds: [],
      confidence: 0.5,
    });
  }
  await reRankValues(aId, { values_to_boost: [{ key: "ship_fast", reason: "reinforced" }] });
  const aVal = (await getUserModel(aId, "value")).find((e) => e.key === "ship_fast");
  const bVal = (await getUserModel(bId, "value")).find((e) => e.key === "ship_fast");
  check("[quickfix] reRankValues boosts the target owner's value", (aVal?.confidence ?? 0) > 0.5);
  check(
    "[quickfix] reRankValues does NOT touch another owner (no cross-tenant write)",
    bVal?.confidence === 0.5,
  );
  // The re-upsert must round-trip value as an object, not a double-encoded
  // string (consumers cast value to an object).
  check(
    "[quickfix] user_model value round-trips as an object after re-upsert (no double-encode)",
    typeof aVal?.value === "object" &&
      aVal?.value !== null &&
      (aVal?.value as Record<string, unknown> | undefined)?.value === "ship fast",
  );

  if (!KEEP) {
    await db.deleteFrom("sessions").where("session_key", "=", rKey).execute();
    await db
      .deleteFrom("ingest_jobs")
      .where("platform", "in", ["eval-delta-a", "eval-delta-b"])
      .execute();
    await db.deleteFrom("user_model").where("user_id", "in", [aId, bId]).execute();
  }
}

async function runGetMessagesWire(): Promise<void> {
  // MobileApi.GetMessages over the authenticated Connect wire: multi-session AND
  // per-user isolation. Deterministic (no LLM): seeds owned sessions + transcripts
  // directly, then reads them back over the wire as each tenant.
  const auth = await startHostedAuth("eval-org");
  const ids = ["eval-alice", "eval-bob"];
  await seedOrgMembers(ids);
  const server = await startConnectServer();
  const alice = makeMobileClient(server.port, () => auth.mint("eval-alice"));
  const bob = makeMobileClient(server.port, () => auth.mint("eval-bob"));
  const aKey1 = "mobile:gm-alice:s1";
  const aKey2 = "mobile:gm-alice:s2";
  const bKey = "mobile:gm-bob:s1";
  try {
    const sA1 = await createSession({ sessionKey: aKey1, userId: "eval-alice" });
    const sA2 = await createSession({ sessionKey: aKey2, userId: "eval-alice" });
    const sB1 = await createSession({ sessionKey: bKey, userId: "eval-bob" });
    await appendTranscriptMessage({
      sessionId: sA1.id,
      userId: "eval-alice",
      role: "user",
      content: "alice s1 question",
    });
    await appendTranscriptMessage({
      sessionId: sA1.id,
      userId: "eval-alice",
      role: "assistant",
      content: "alice s1 answer: Dr. Patel",
    });
    await appendTranscriptMessage({
      sessionId: sA2.id,
      userId: "eval-alice",
      role: "user",
      content: "alice s2 question",
    });
    await appendTranscriptMessage({
      sessionId: sB1.id,
      userId: "eval-bob",
      role: "user",
      content: "bob s1 question",
    });

    const a1 = await alice.getMessages({ sessionKey: aKey1, limit: 50 });
    check(
      "[getmessages] author retrieves own session over the wire",
      a1.messages.length === 2 &&
        a1.messages[0].role === "user" &&
        a1.messages[1].content.includes("Patel"),
    );
    check(
      "[getmessages] messages are chronological with ids + createdAt",
      a1.messages.every((m) => m.id !== "" && m.createdAt !== "") &&
        Number(a1.messages[0].id) < Number(a1.messages[1].id),
    );
    const a2 = await alice.getMessages({ sessionKey: aKey2, limit: 50 });
    check(
      "[getmessages] a second session is isolated (multi-session)",
      a2.messages.length === 1 && a2.messages[0].content.includes("s2"),
    );
    const crossB = await alice.getMessages({ sessionKey: bKey, limit: 50 });
    check(
      "[getmessages] cross-user GetMessages returns empty (user-scoped)",
      crossB.messages.length === 0,
    );
    const ownB = await bob.getMessages({ sessionKey: bKey, limit: 50 });
    check("[getmessages] each tenant sees only its own session", ownB.messages.length === 1);

    let rejected = false;
    try {
      await makeMobileClient(server.port).getMessages({ sessionKey: aKey1, limit: 50 });
    } catch (err) {
      rejected = err instanceof ConnectError && err.code === Code.Unauthenticated;
    }
    check("[getmessages] unauthenticated GetMessages is rejected at the wire", rejected);
  } finally {
    await server.stop();
    if (!KEEP) {
      for (const k of [aKey1, aKey2, bKey]) {
        await getKysely()
          .deleteFrom("sessions")
          .where("session_key", "=", k)
          .execute()
          .catch(() => undefined);
      }
      await removeOrgMembers(ids);
      for (const id of ids) await purgeSyntheticTenant(id);
    }
    await auth.stop();
  }
}

async function runCommitments(): Promise<void> {
  // commitments: proactive promise tracking, per-user scoped (deterministic).
  const A = "eval-commit-a";
  const B = "eval-commit-b";
  await storeCommitments(
    A,
    [{ description: "send the quarterly report", deadline: null, contact: null }],
    "msg-a",
  );
  await storeCommitments(
    B,
    [{ description: "review the PR", deadline: null, contact: null }],
    "msg-b",
  );

  const pendA = await getPendingCommitments(A);
  check(
    "[commitments] stored + listed per owner",
    pendA.length >= 1 && pendA.every((c) => c.user_id === A),
  );
  check(
    "[commitments] source_msg round-trips (reminder context)",
    pendA.some((c) => c.source_msg === "msg-a"),
  );
  check(
    "[commitments] B does not see A's commitments",
    (await getPendingCommitments(B)).every(
      (c) => c.user_id === B && c.description !== "send the quarterly report",
    ),
  );

  // Commitment -> contact linking: the extractor names who a promise is to, and
  // storeCommitments must resolve that name to a contact_id (regression guard for
  // the dropped-on-insert bug). An unnamed commitment stays unlinked (null).
  const sarah = await createContact(A, { displayName: "Sarah Lin" });
  const [linked] = await storeCommitments(
    A,
    [{ description: "send Sarah the deck", deadline: null, contact: "Sarah" }],
    "msg-link",
  );
  check(
    "[commitments] a named contact resolves to contact_id",
    linked?.contact_id === sarah.id,
    `contact_id=${linked?.contact_id ?? "null"} expected=${sarah.id}`,
  );

  // Reminder window: a commitment due within 24h surfaces for reminders; the
  // earlier no-deadline one does not. Drives the __commitment_reminders__ path.
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await storeCommitments(A, [{ description: "ping the client", deadline: soon, contact: null }]);
  const remind = await getCommitmentsForReminder(A);
  check(
    "[commitments] near-deadline commitment surfaces for reminder",
    remind.some((c) => c.description === "ping the client"),
  );
  check(
    "[commitments] no-deadline commitment is not in the reminder set",
    remind.every((c) => c.description !== "send the quarterly report"),
  );
}

async function runSessionResume(): Promise<void> {
  // Regression guard for the session-metadata fix: persist an SDK session id and
  // read it back. A double-encoded jsonb *string* would make metadata.sdkSessionId
  // undefined and silently break cross-restart resume.
  const key = "slack:eval-resume";
  const scope = { platform: "slack", channelId: "eval-resume" };
  const SDK_ID = "sdk-eval-9f3c";
  const db = getKysely();
  await db.deleteFrom("sessions").where("session_key", "=", key).execute();
  // Row must exist first: setWithDbPersist only UPDATEs by session_key.
  await createSession({ sessionKey: key, model: "claude-opus-4-8", metadata: {} });
  await new SessionStore("channel").setWithDbPersist(scope, SDK_ID);

  const row = await getSessionByKey(key);
  const meta = row?.metadata as Record<string, unknown> | undefined;
  check(
    "[session-resume] metadata is a jsonb object (not a double-encoded string)",
    typeof meta === "object" && meta !== null,
  );
  check(
    "[session-resume] sdkSessionId round-trips for cross-restart resume",
    typeof meta?.sdkSessionId === "string" && meta.sdkSessionId === SDK_ID,
  );
  check(
    "[session-resume] a cold instance resumes the SDK session from the DB",
    (await new SessionStore("channel").getWithDbFallback(scope)) === SDK_ID,
  );
  if (!KEEP) await db.deleteFrom("sessions").where("session_key", "=", key).execute();
}

async function runCron(): Promise<void> {
  // cron_jobs / cron_runs: scheduled tasks. The owner is tagged on the job (cron is
  // global at the store layer; isolation rides database-per-customer).
  const store = new CronStore();
  const jobId = await store.createJob({
    userId: "eval-cron-a",
    name: "eval-cron-job",
    schedule: "0 9 * * *",
    scheduleType: "cron",
    sessionTarget: "isolated",
    deliveryMode: "announce",
    prompt: "summarize yesterday",
    enabled: true,
    errorCount: 0,
  });
  const job = await store.getJob(jobId);
  check(
    "[cron] job created + owner round-trips",
    job != null && job.userId === "eval-cron-a" && job.scheduleType === "cron",
  );

  const runId = await store.recordRunStart(jobId, "eval-cron-job", `cron:${jobId}:1`);
  await store.recordRunEnd(runId, true, 1200);
  const runs = await store.listRuns({ jobId });
  check(
    "[cron] run recorded + retrievable",
    runs.length === 1 && runs[0]!.success === true && runs[0]!.durationMs === 1200,
  );
  const stats = await store.getRunStats(jobId);
  check("[cron] run stats reflect the run", stats.totalRuns === 1 && stats.successCount === 1);
  if (!KEEP) await store.deleteJob(jobId); // cron_runs cascade via FK
}

async function runTasks(): Promise<void> {
  // scheduled-tasks: the consumer Tasks surface (curateConsumerTasks, served behind
  // BOTH NomosAgent.ListTasks and MobileApi.ListTasks). A reminder the assistant
  // scheduled via schedule_task (source='agent') must surface; the instance's
  // always-on system/bundled infra loops -- which collapse onto the owner's user_id
  // in power-user mode -- must be filtered OUT by curateConsumerTasks' source guard.
  // Deterministic (no LLM): the live agent->schedule_task->Tasks path is covered by
  // the iOS XCUITest; here we guard the durable effect + the curation/filter.
  const store = new CronStore();
  const owner = "eval-tasks-a";
  // cron_jobs.name is globally UNIQUE (idx_cron_name), so namespace both rows to avoid
  // colliding with seeded loops in nomos_eval.
  const reminderId = await store.createJob({
    userId: owner,
    name: "eval-tasks-call-dentist",
    schedule: "2026-06-18T09:00:00",
    scheduleType: "at",
    sessionTarget: "isolated",
    deliveryMode: "none",
    prompt: "Remind the user to call the dentist",
    enabled: true,
    errorCount: 0,
    source: "agent", // what schedule_task stamps for a user-owned task
  });
  const infraId = await store.createJob({
    userId: owner, // same user_id as the reminder (power-user collapses system onto the owner)
    name: "eval-tasks-infra-loop",
    schedule: "6h",
    scheduleType: "every",
    sessionTarget: "isolated",
    deliveryMode: "none",
    prompt: "consolidate",
    enabled: true,
    errorCount: 0,
    source: "system", // an infra loop -- must NOT appear on Tasks
  });

  const tasks = curateConsumerTasks(await store.listJobs({ userId: owner }));
  check(
    "[tasks] a schedule_task reminder (source=agent) surfaces on the consumer Tasks view",
    tasks.some((t) => t.id === reminderId && t.source === "agent" && t.scheduleType === "at"),
    `tasks=${tasks.map((t) => `${t.name}:${t.source}`).join(", ")}`,
  );
  check(
    "[tasks] system/bundled infra loops are filtered out of Tasks (curateConsumerTasks source guard)",
    !tasks.some((t) => t.id === infraId) &&
      tasks.every((t) => t.source !== "system" && t.source !== "bundled"),
  );

  // Under --audit (KEEP) the source=agent reminder is intentionally left in nomos_eval
  // so the scheduled-tasks effect SQL (source IN ('agent','user')) is exercised, not
  // just declared. A plain run cleans both up.
  if (!KEEP) {
    await store.deleteJob(reminderId);
    await store.deleteJob(infraId);
  }
}

async function runDrafts(): Promise<void> {
  // draft_messages: consent-aware outgoing drafts. Per-user at the LIST layer;
  // status state machine is pending -> approved -> sent, or pending -> rejected.
  const A = "eval-draft-a";
  const B = "eval-draft-b";
  const dA = await createDraft({
    platform: "slack",
    channelId: "C_EVAL",
    userId: A,
    inReplyTo: "m1",
    content: "from A",
    context: { source: "eval" },
  });
  const dB = await createDraft({
    platform: "slack",
    channelId: "C_EVAL",
    userId: B,
    inReplyTo: "m2",
    content: "from B",
  });

  check(
    "[drafts] created pending + listed per owner",
    (await getDraft(dA.id))?.status === "pending" &&
      (await listPendingDrafts(A)).some((d) => d.id === dA.id),
  );
  check(
    "[drafts] A's pending list excludes B's draft",
    (await listPendingDrafts(A)).every((d) => d.id !== dB.id),
  );

  const approved = await approveDraft(dA.id);
  check(
    "[drafts] approve transitions pending -> approved (drops from pending)",
    approved?.status === "approved" && (await listPendingDrafts(A)).every((d) => d.id !== dA.id),
  );
  check(
    "[drafts] re-approving a non-pending draft is a no-op",
    (await approveDraft(dA.id)) === null,
  );
  check("[drafts] approved -> sent", (await markDraftSent(dA.id))?.status === "sent");

  const rejected = await rejectDraft(dB.id);
  check(
    "[drafts] reject transitions pending -> rejected",
    rejected?.status === "rejected" && (await listPendingDrafts(B)).length === 0,
  );
  if (!KEEP)
    await getKysely().deleteFrom("draft_messages").where("user_id", "in", [A, B]).execute();
}

async function runAutoLinkerGuard(): Promise<void> {
  // Regression guard for the cross-tenant merge data-loss bug: the auto-linker
  // (deterministic, owner-scoped SQL) must merge within a user but NEVER touch
  // another user's contacts.
  const A = "eval-autolink-a";
  const B = "eval-autolink-b";
  await resolveContact(A, "slack", "U_A1", "Alice", "dup@example.com");
  await resolveContact(A, "email", "alice@work", "Alice", "dup@example.com");
  const b1 = await resolveContact(B, "slack", "U_B1", "Alice", "dup@example.com");
  await resolveContact(B, "email", "alice@work", "Alice", "dup@example.com");

  const bBefore = JSON.stringify((await listContacts(B)).map((c) => c.id).sort());
  await runAutoLinker(A);

  const aAfter = await listContacts(A);
  check("[auto-linker] merges a user's own duplicate contacts (2 -> 1)", aAfter.length === 1);
  check(
    "[auto-linker] survivor owns both identities",
    aAfter.length === 1 && (await listIdentities(A, aAfter[0]!.id)).length === 2,
  );
  check(
    "[auto-linker] another tenant's contacts are untouched (regression guard)",
    JSON.stringify((await listContacts(B)).map((c) => c.id).sort()) === bBefore,
  );
  await mergeContacts(A, aAfter[0]?.id ?? "none", b1.contact.id);
  check(
    "[auto-linker] cross-user mergeContacts does not delete B's contact",
    (await listContacts(B)).some((c) => c.id === b1.contact.id),
  );

  // contact_identities.metadata is now plumbed (was always '{}'); round-trips as
  // an object (the double-encode guard the agent's JSON.stringify fix would fail).
  const meta = await resolveContact(A, "discord", "U_META", "Meta User", undefined, {
    handle: "u-meta",
    avatar: "a.png",
  });
  const ciRow = await getKysely()
    .selectFrom("contact_identities")
    .select("metadata")
    .where("id", "=", meta.identity.id)
    .executeTakeFirst();
  check(
    "[identity] contact_identities.metadata round-trips as an object (not double-encoded)",
    typeof ciRow?.metadata === "object" &&
      ciRow?.metadata !== null &&
      (ciRow?.metadata as Record<string, unknown> | undefined)?.handle === "u-meta",
  );

  // Contact enrichment on resolution: a job title in the inbound metadata lands on
  // contacts.role, a new contact gets a provenance note, and each resolution
  // records interaction stats in the relationship jsonb -- wiring the previously
  // dormant relationship subsystem onto the live inbound identity path.
  const enr = await resolveContact(A, "slack", "U_ENR", "Priya R", undefined, {
    title: "Engineering Manager",
  });
  const erow = await getKysely()
    .selectFrom("contacts")
    .selectAll()
    .where("id", "=", enr.contact.id)
    .executeTakeFirstOrThrow();
  const rel = (erow.relationship ?? {}) as Record<string, unknown>;
  check(
    "[identity] inbound job title enriches contacts.role",
    erow.role === "Engineering Manager",
    `role=${erow.role ?? "null"}`,
  );
  check(
    "[identity] a new contact gets a provenance note",
    typeof erow.notes === "string" && (erow.notes ?? "").length > 0,
    `notes=${erow.notes ?? "null"}`,
  );
  check(
    "[identity] resolution records relationship interaction stats (jsonb)",
    typeof rel.lastContact === "string" &&
      Number(rel.messageCount) >= 1 &&
      rel.role === "Engineering Manager",
    `relationship=${JSON.stringify(rel)}`,
  );

  if (!KEEP) {
    const db = getKysely();
    for (const uid of [A, B]) {
      await db.deleteFrom("contact_identities").where("user_id", "=", uid).execute();
      await db.deleteFrom("contacts").where("user_id", "=", uid).execute();
    }
  }
}

async function runManagedFiles(): Promise<void> {
  // managed_files: content-addressed DB backup of disk config (global; the daemon
  // restores from it on boot). Round-trip + sha-256 hash + idempotent upsert.
  const { createHash } = await import("node:crypto");
  const path = "eval/managed-test.md";
  await syncFileToDb(path, "hello world");
  const row = await getKysely()
    .selectFrom("managed_files")
    .select(["content", "hash"])
    .where("path", "=", path)
    .executeTakeFirst();
  check(
    "[managed-files] write + read round-trips with a sha-256 hash",
    row?.content === "hello world" &&
      row?.hash === createHash("sha256").update("hello world", "utf-8").digest("hex"),
  );
  await syncFileToDb(path, "v2");
  const again = await getKysely()
    .selectFrom("managed_files")
    .select(["content"])
    .where("path", "=", path)
    .executeTakeFirst();
  check(
    "[managed-files] upsert by path updates in place (no duplicate row)",
    again?.content === "v2",
  );
  if (!KEEP) await getKysely().deleteFrom("managed_files").where("path", "=", path).execute();
}

async function runStyleProfiles(): Promise<void> {
  // style_profiles: the per-turn voice guidance reads row.profile as an object,
  // so this guards the jsonb double-encode (real DB only) + per-user scoping.
  const { upsertStyleProfile, getStyleProfile } = await import("../src/db/style-profiles.ts");
  const db = getKysely();
  const A = "eval-style-a";
  const B = "eval-style-b";
  await db.deleteFrom("style_profiles").where("user_id", "in", [A, B]).execute();

  const mk = (formality: number) => ({
    formality,
    avgLength: 12,
    emojiUsage: "rare" as const,
    punctuation: "standard",
    greetingStyle: "none",
    signoffStyle: "none",
    vocabulary: ["lgtm"],
    tone: "direct",
    casing: "standard",
    responseSpeed: "brief",
  });

  await upsertStyleProfile(A, null, "global", mk(1), 10);
  await upsertStyleProfile(B, null, "global", mk(5), 7);

  const rowA = await getStyleProfile(A, "global");
  check(
    "[style] profile round-trips as a jsonb object (not a double-encoded string)",
    typeof rowA?.profile === "object" &&
      rowA?.profile !== null &&
      (rowA?.profile as Record<string, unknown> | undefined)?.formality === 1,
  );
  check(
    "[style] B's global profile is its own (per-user scoped)",
    (await getStyleProfile(B, "global"))?.profile &&
      ((await getStyleProfile(B, "global"))?.profile as Record<string, unknown> | undefined)
        ?.formality === 5,
  );
  // Re-upsert A: the unique key is (user_id, scope), so it updates in place.
  await upsertStyleProfile(A, null, "global", mk(2), 11);
  const reA = await db
    .selectFrom("style_profiles")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", A)
    .where("scope", "=", "global")
    .executeTakeFirst();
  check("[style] upsert by (user_id, scope) updates in place (no duplicate)", Number(reA?.n) === 1);

  if (!KEEP) await db.deleteFrom("style_profiles").where("user_id", "in", [A, B]).execute();
}

async function runStudioLearn(): Promise<void> {
  // Studio learning: drive the REAL capture -> distill -> store path. Four committed
  // edits fill recordEditSignal's buffer and trip flushPhotoStyle, which distills them
  // (forked Haiku) into an editable photo-style.md vault note + photo_style user_model
  // entries -- the exact rows suggestEdits + auto-enhance read back to personalize.
  // Asserts both durable effects, the apply-side read, and per-user isolation.
  const { recordEditSignal, readPhotoStyle, flushPhotoStyle } =
    await import("../src/studio/learn.ts");
  const db = getKysely();
  const A = "eval-photo-a";
  const B = "eval-photo-b";
  const clear = async (): Promise<void> => {
    await db
      .deleteFrom("vault_notes")
      .where("user_id", "in", [A, B])
      .where("path", "=", "photo-style.md")
      .execute();
    await db
      .deleteFrom("user_model")
      .where("user_id", "in", [A, B])
      .where("category", "=", "photo_style")
      .execute();
  };
  const styleNote = (): Promise<{ content: string } | undefined> =>
    db
      .selectFrom("vault_notes")
      .select(["content"])
      .where("user_id", "=", A)
      .where("path", "=", "photo-style.md")
      .executeTakeFirst();
  const photoPrefCount = async (userId: string): Promise<number> =>
    Number(
      (
        await db
          .selectFrom("user_model")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("user_id", "=", userId)
          .where("category", "=", "photo_style")
          .executeTakeFirst()
      )?.n ?? 0,
    );
  await clear();

  // Capture + read gate on NOMOS_ADAPTIVE_MEMORY (same flag as all other learning).
  const priorAdaptive = process.env.NOMOS_ADAPTIVE_MEMORY;
  process.env.NOMOS_ADAPTIVE_MEMORY = "true";
  try {
    if (!hasLLM) {
      skip(
        "[studio-learn] distills applied edits into a photo-style vault note + user_model",
        "no LLM provider configured",
      );
      return;
    }

    const edits = [
      "warm up the photo and add a soft golden-hour glow",
      "smooth the skin but keep the pores and natural texture",
      "deepen the contrast and make the colors pop",
      "brighten the eyes and gently whiten the teeth",
    ];
    const signals = edits.map((instruction) => ({ op: "editSemantic", instruction }));
    // The real path: 4 edits fill the buffer and trip the flush (FLUSH_EVERY).
    for (const s of signals) await recordEditSignal(A, s.op, s.instruction);

    // recordEditSignal swallows flush errors by design (fire-and-forget); if nothing
    // landed, drive the distiller directly so a genuine failure surfaces with a reason.
    let note = await styleNote();
    if (!note?.content) {
      await flushPhotoStyle(A, signals);
      note = await styleNote();
    }

    check(
      "[studio-learn] writes an editable photo-style.md vault note",
      !!note?.content && note.content.trim().length > 0,
      note?.content?.slice(0, 80),
    );
    check(
      "[studio-learn] accumulates photo_style preferences in the user model",
      (await photoPrefCount(A)) >= 1,
      `count=${await photoPrefCount(A)}`,
    );
    // Apply side: readPhotoStyle is what the engine (auto-enhance) + suggestEdits inject.
    check(
      "[studio-learn] readPhotoStyle surfaces the learned style for injection",
      (await readPhotoStyle(A)).length > 0,
    );
    // Per-user scoped: B applied no edits, so it has neither the note nor any prefs.
    check(
      "[studio-learn] B (no edits) has no photo-style note or prefs (per-user scoped)",
      (await readPhotoStyle(B)).length === 0 && (await photoPrefCount(B)) === 0,
    );
  } finally {
    if (priorAdaptive === undefined) delete process.env.NOMOS_ADAPTIVE_MEMORY;
    else process.env.NOMOS_ADAPTIVE_MEMORY = priorAdaptive;
    if (!KEEP) await clear();
  }
}

async function runMoodLog(): Promise<void> {
  // Emotional presence: record a mood EPISODE (cause, not a standing state) -> the
  // editable mood-log.md vault note. Deterministic (no LLM) -- recordMoodEpisode just
  // upserts. Asserts the durable effect, the open-episode read, and per-user isolation.
  const { recordMoodEpisode, readOpenMoodEpisodes } = await import("../src/memory/mood-log.ts");
  const db = getKysely();
  const A = "eval-mood-a";
  const B = "eval-mood-b";
  const clear = async (): Promise<void> => {
    await db
      .deleteFrom("vault_notes")
      .where("user_id", "in", [A, B])
      .where("path", "=", "mood-log.md")
      .execute();
  };
  const moodCount = async (userId: string): Promise<number> =>
    Number(
      (
        await db
          .selectFrom("vault_notes")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("user_id", "=", userId)
          .where("path", "=", "mood-log.md")
          .executeTakeFirst()
      )?.n ?? 0,
    );
  await clear();

  const priorAdaptive = process.env.NOMOS_ADAPTIVE_MEMORY;
  process.env.NOMOS_ADAPTIVE_MEMORY = "true";
  try {
    await recordMoodEpisode(A, "stressed", "Q3 launch");
    check(
      "[mood-episodes] persists an editable mood-log.md vault note",
      (await moodCount(A)) >= 1,
      `count=${await moodCount(A)}`,
    );
    const open = await readOpenMoodEpisodes(A);
    check(
      "[mood-episodes] readOpenMoodEpisodes surfaces the open episode by cause",
      open.some((e) => /q3 launch/i.test(e.cause)),
    );
    check(
      "[mood-episodes] B (no episode) has no mood log (per-user scoped)",
      (await moodCount(B)) === 0,
    );
  } finally {
    if (priorAdaptive === undefined) delete process.env.NOMOS_ADAPTIVE_MEMORY;
    else process.env.NOMOS_ADAPTIVE_MEMORY = priorAdaptive;
    if (!KEEP) await clear();
  }
}

async function runRelationshipNarrative(): Promise<void> {
  // Shared experience: seed a learned user_model, then generate an agent-authored
  // narrative (forked Haiku) -> the editable relationship.md vault note. Asserts the
  // durable effect + that B (nothing learned) writes nothing (per-user scoped).
  const { writeRelationshipNarrative } = await import("../src/memory/relationship-narrative.ts");
  const { upsertUserModel } = await import("../src/db/user-model.ts");
  const db = getKysely();
  const A = "eval-rel-a";
  const B = "eval-rel-b";
  const clear = async (): Promise<void> => {
    await db
      .deleteFrom("vault_notes")
      .where("user_id", "in", [A, B])
      .where("path", "=", "relationship.md")
      .execute();
    await db
      .deleteFrom("user_model")
      .where("user_id", "in", [A, B])
      .where("category", "=", "rel_eval")
      .execute();
  };
  const relCount = async (userId: string): Promise<number> =>
    Number(
      (
        await db
          .selectFrom("vault_notes")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("user_id", "=", userId)
          .where("path", "=", "relationship.md")
          .executeTakeFirst()
      )?.n ?? 0,
    );
  await clear();

  const priorAdaptive = process.env.NOMOS_ADAPTIVE_MEMORY;
  process.env.NOMOS_ADAPTIVE_MEMORY = "true";
  try {
    if (!hasLLM) {
      skip(
        "[relationship-narrative] writes a relationship.md narrative from the user model",
        "no LLM provider configured",
      );
      return;
    }
    const seeded: [string, string][] = [
      ["ships_fast", "prioritizes shipping speed over premature optimization"],
      ["testing", "values integration tests as much as unit tests"],
      ["tone", "prefers terse, direct answers"],
      ["role", "founder of an early-stage startup"],
      ["decisions", "asks clarifying questions before diving in"],
    ];
    for (const [key, value] of seeded) {
      await upsertUserModel({
        userId: A,
        category: "rel_eval",
        key,
        value,
        sourceIds: [],
        confidence: 0.8,
      });
    }

    const r = await writeRelationshipNarrative(A);
    check(
      "[relationship-narrative] writes an editable relationship.md vault note",
      r.wrote && (await relCount(A)) >= 1,
      r.reason ?? "wrote",
    );
    const rb = await writeRelationshipNarrative(B);
    check(
      "[relationship-narrative] B (nothing learned) writes nothing (per-user scoped)",
      !rb.wrote && (await relCount(B)) === 0,
    );
  } finally {
    if (priorAdaptive === undefined) delete process.env.NOMOS_ADAPTIVE_MEMORY;
    else process.env.NOMOS_ADAPTIVE_MEMORY = priorAdaptive;
    if (!KEEP) await clear();
  }
}

async function runWikiArticles(): Promise<void> {
  // Derived store: wiki_articles. Deterministic write + per-user isolation, then
  // the full LLM compile (2 Sonnet passes) pointed at a temp NOMOS_WIKI_DIR so it
  // never touches the real ~/.nomos/wiki.
  const A = "eval-wiki-a";
  const B = "eval-wiki-b";
  await upsertArticle(A, "contacts/alice.md", "Alice", "Alice is A's contact.", "contacts");
  await upsertArticle(B, "contacts/zara.md", "Zara", "Zara is B's contact.", "contacts");

  const listA = await listArticles(A);
  check(
    "[wiki] articles are written + listed per owner",
    listA.length >= 1 && listA.every((a) => a.user_id === A),
  );
  check(
    "[wiki] B's article search is owner-scoped",
    (await searchArticles(B, "Alice")).every((a) => a.user_id === B),
  );
  check(
    "[wiki] A cannot see B's article",
    (await listArticles(A)).every((a) => a.path !== "contacts/zara.md"),
  );

  // getRelevantArticles is what the live turn path injects into the prompt.
  const relA = await getRelevantArticles(A, "Alice");
  check(
    "[wiki] getRelevantArticles surfaces the owner's matching article",
    relA.includes("Alice is A's contact.") && relA.includes("Personal Knowledge Wiki"),
  );
  check(
    "[wiki] getRelevantArticles is owner-scoped (B's query never returns A's content)",
    !(await getRelevantArticles(B, "Alice")).includes("Alice is A's contact."),
  );

  // Config wiring: the four app.wiki* settings the compiler reads (resolveWiki)
  // must be seeded, else the feature silently falls back to constants.
  const wikiCfgRows = await getKysely()
    .selectFrom("config")
    .select(["key"])
    .where("key", "in", [
      "app.wikiEnabled",
      "app.wikiCompileInterval",
      "app.wikiCompileModel",
      "app.wikiMaxArticlesPerRun",
    ])
    .execute();
  check(
    "[wiki-config] all four app.wiki* settings are seeded in the config table",
    wikiCfgRows.length === 4,
    `found ${wikiCfgRows.length}/4: ${wikiCfgRows.map((r) => r.key).join(", ")}`,
  );

  // The on/off gate: app.wikiEnabled=false makes compileKnowledge a no-op on every
  // path (no LLM call -- the gate returns before any work).
  const disabled = await compileKnowledge({
    userId: A,
    force: true,
    wikiConfig: { enabled: false },
  });
  check(
    "[wiki-config] wikiEnabled=false makes the compiler a no-op (hard off-switch)",
    disabled.articlesCreated + disabled.articlesUpdated === 0 &&
      disabled.errors.some((e) => e.includes("disabled")),
    disabled.errors.join("; "),
  );

  if (!hasLLM) {
    skip("[wiki] LLM compile produces articles from the vault", "no LLM provider configured");
    return;
  }
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const wikiDir = mkdtempSync(joinPath(tmpdir(), "nomos-eval-wiki-"));
  const target = joinPath(wikiDir, "wiki");
  // Compile in HOSTED mode: the DB (wiki_articles) must get the articles while the
  // disk mirror is skipped (in multi-node hosted a per-pod disk copy just diverges).
  process.env.NOMOS_WIKI_DIR = target;
  process.env.NOMOS_MODE = "hosted";
  process.env.NOMOS_ORG_ID = "eval-org";
  try {
    // Seed a realistic multi-note brain so the compiler produces several genuine
    // articles (and the kept DB is worth browsing), not just one thin note.
    await seedRichVault(A);
    const vaultCount = await getKysely()
      .selectFrom("vault_notes")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", A)
      .executeTakeFirst();
    check(
      "[wiki] rich vault seeded (profile + people + project + procedure)",
      Number(vaultCount?.n ?? 0) >= 6,
    );

    // Inject a NON-default model so honoring it is observable in the compile_model
    // column (proves resolveWiki -> wiki.model threads end-to-end, not the constant).
    const injectedModel = "claude-haiku-4-5";
    const res = await compileKnowledge({
      userId: A,
      force: true,
      wikiConfig: { model: injectedModel },
    });
    check(
      "[wiki] LLM compile produces multiple articles from the vault",
      res.articlesCreated + res.articlesUpdated >= 2,
      `created=${res.articlesCreated} updated=${res.articlesUpdated} ${res.errors.join("; ")}`.trim(),
    );
    check(
      "[wiki] compiled articles are owner-scoped",
      (await listArticles(A)).every((a) => a.user_id === A),
    );
    // Only LLM-compiled content articles carry a compile_model (deterministic
    // upserts + _index leave it null), so this isolates the config-driven path.
    const modeled = (await listArticles(A)).filter((a) => a.compile_model);
    check(
      "[wiki-config] compiler honors app.wikiCompileModel (compiled articles carry the injected model)",
      modeled.length >= 1 && modeled.every((a) => a.compile_model === injectedModel),
      `models=${[...new Set(modeled.map((a) => a.compile_model))].join(", ") || "none"}`,
    );
    check(
      "[wiki] hosted compile keeps the wiki in the DB, not on disk (multi-node safe)",
      !existsSync(target),
    );
  } finally {
    delete process.env.NOMOS_WIKI_DIR;
    delete process.env.NOMOS_MODE;
    delete process.env.NOMOS_ORG_ID;
    rmSync(wikiDir, { recursive: true, force: true });
  }
}

async function runGraphMetadata(): Promise<void> {
  // kg_nodes carry aliases (TEXT[]) + attrs (JSONB metadata) + confidence; kg_edges
  // carry a fact (TEXT) + attrs (JSONB) + confidence. Assert all of it round-trips
  // (incl. mergeNodeAttrs folding a key), per-user scoped.
  const ctx = { orgId: "eval-org", userId: "eval-kgmeta" };
  const db = getKysely();
  await db.deleteFrom("kg_edges").where("user_id", "=", ctx.userId).execute();
  await db.deleteFrom("kg_nodes").where("user_id", "=", ctx.userId).execute();

  const aliceId = await upsertNode(ctx, {
    kind: "person",
    name: "Alice Ferreira",
    aliases: ["Ali", "A. Ferreira"],
    attrs: { phone: "+15551234567", email: "alice@example.com" },
    confidence: 0.9,
  });
  const acmeId = await upsertNode(ctx, { kind: "org", name: "Acme Corp", confidence: 0.8 });
  await mergeNodeAttrs(ctx, aliceId, { url: "https://alice.example" });
  const edgeId = await upsertEdge(ctx, {
    srcId: aliceId,
    dstId: acmeId,
    relType: "works_at",
    fact: "Alice is a staff engineer at Acme Corp since 2021",
    attrs: { role: "Staff Engineer", since: "2021" },
    confidence: 0.95,
  });

  const alice = await getNode(ctx, aliceId);
  check(
    "[kg-meta] node aliases round-trip",
    JSON.stringify([...(alice?.aliases ?? [])].sort()) === JSON.stringify(["A. Ferreira", "Ali"]),
  );
  check(
    "[kg-meta] node attrs (metadata bag) round-trip incl. mergeNodeAttrs",
    alice?.attrs.phone === "+15551234567" &&
      alice?.attrs.email === "alice@example.com" &&
      alice?.attrs.url === "https://alice.example",
  );
  check("[kg-meta] node confidence round-trips", alice?.confidence === 0.9);

  const sub = await neighborhood(ctx, aliceId, { depth: 1 });
  const edge = sub.edges.find((e) => e.id === edgeId);
  check(
    "[kg-meta] edge fact + attrs + confidence round-trip",
    edge?.fact === "Alice is a staff engineer at Acme Corp since 2021" &&
      edge?.attrs.role === "Staff Engineer" &&
      edge?.confidence === 0.95,
  );
  // Per-user: another tenant cannot read this node by id.
  check(
    "[kg-meta] node is owner-scoped",
    (await getNode({ orgId: "eval-org", userId: "eval-other" }, aliceId)) === undefined,
  );
}

async function runBacklinks(): Promise<void> {
  // vault_notes.backlinks (auto-derived from [[links]]) and wiki_articles.backlinks
  // (passed explicitly) are native TEXT[] columns. Assert they store + read back.
  const U = "eval-backlinks";
  await vaultWrite(U, "notes/trip.md", "Met [[Dana]] and [[ Acme ]]; ping [[Dana]] again");
  const vrow = await getVaultNote(U, "notes/trip.md"); // db layer: vaultRead strips backlinks
  check(
    "[backlinks] vault [[links]] are extracted, deduped + trimmed",
    JSON.stringify(vrow?.backlinks) === JSON.stringify(["Dana", "Acme"]),
  );
  check(
    "[backlinks] vault backlinks are plain strings (no double-encoding)",
    (vrow?.backlinks ?? []).every((b) => typeof b === "string" && !b.startsWith('"')),
  );

  await upsertArticle(U, "contacts/dana.md", "Dana", "Dana profile", "contacts", ["trip", "Acme"]);
  const wrow = await getArticle(U, "contacts/dana.md");
  check(
    "[backlinks] wiki article backlinks round-trip",
    JSON.stringify(wrow?.backlinks) === JSON.stringify(["trip", "Acme"]),
  );
  await upsertArticle(U, "contacts/dana.md", "Dana", "Dana v2", "contacts", ["trip"]);
  check(
    "[backlinks] revising an article updates its backlinks",
    JSON.stringify((await getArticle(U, "contacts/dana.md"))?.backlinks) ===
      JSON.stringify(["trip"]),
  );
}

async function runMetadataColumns(): Promise<void> {
  // JSONB/array column round-trips that the mocked-DB unit tests structurally can't
  // catch: transcript usage, session metadata (custom key), chunk last_accessed_at +
  // access_count, and chunk metadata category.
  const U = "eval-mdcols";
  const db = getKysely();

  // transcript_messages.usage
  const tKey = `eval:usage:${Date.now()}`;
  const ts = await createSession({ sessionKey: tKey, userId: U });
  await appendTranscriptMessage({
    sessionId: ts.id,
    userId: U,
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    usage: { input: 11, output: 22 },
  });
  const msgs = await getTranscriptWithUsage(ts.id);
  check(
    "[md-cols] transcript usage round-trips as {input,output}",
    msgs.length === 1 && msgs[0]!.usage?.input === 11 && msgs[0]!.usage?.output === 22,
  );

  // sessions.metadata: a custom key must read back as an object (proves the
  // double-encoding fix), and jsonb_set via updateSessionSdkId must work.
  const mKey = `eval:meta:${Date.now()}`;
  await createSession({
    sessionKey: mKey,
    userId: U,
    metadata: { project: "apollo", nested: { tier: 3 } },
  });
  const got = await getSessionByKey(mKey);
  const meta = got?.metadata as Record<string, unknown> | undefined;
  check(
    "[md-cols] session metadata custom key reads back as an object",
    typeof meta === "object" &&
      meta?.project === "apollo" &&
      (meta?.nested as { tier?: number })?.tier === 3,
  );
  await updateSessionSdkId(mKey, "sdk-xyz");
  check(
    "[md-cols] jsonb_set on session metadata works (sdkSessionId)",
    ((await getSessionByKey(mKey))?.metadata as Record<string, unknown> | undefined)
      ?.sdkSessionId === "sdk-xyz",
  );

  // memory_chunks: last_accessed_at + access_count via recordMemoryAccess, and
  // metadata.category readable via searchMemoryByCategory.
  const cid = `eval-md:${U}:c1`;
  await storeMemoryChunk({
    id: cid,
    userId: U,
    source: "conversation",
    text: "remember me",
    metadata: { category: "note" },
  });
  const before = await db
    .selectFrom("memory_chunks")
    .select(["access_count", "last_accessed_at"])
    .where("id", "=", cid)
    .where("user_id", "=", U)
    .executeTakeFirst();
  check(
    "[md-cols] new chunk starts at access_count 0, last_accessed_at null",
    before?.access_count === 0 && before?.last_accessed_at === null,
  );
  await recordMemoryAccess(U, [cid]);
  const after = await db
    .selectFrom("memory_chunks")
    .select(["access_count", "last_accessed_at"])
    .where("id", "=", cid)
    .where("user_id", "=", U)
    .executeTakeFirst();
  check(
    "[md-cols] recordMemoryAccess bumps access_count + sets last_accessed_at",
    after?.access_count === 1 && after?.last_accessed_at !== null,
  );
  await recordMemoryAccess("eval-md-other", [cid]); // wrong owner: zero-trust no-op
  const guarded = await db
    .selectFrom("memory_chunks")
    .select("access_count")
    .where("id", "=", cid)
    .executeTakeFirst();
  check(
    "[md-cols] recordMemoryAccess is owner-scoped (wrong owner is a no-op)",
    guarded?.access_count === 1,
  );
  const byCat = await searchMemoryByCategory(U, "note", 10);
  check(
    "[md-cols] chunk metadata.category is a readable object (not double-encoded)",
    byCat.some((r) => r.id === cid) &&
      byCat.find((r) => r.id === cid)?.metadata?.category === "note",
  );

  if (!KEEP) await db.deleteFrom("sessions").where("user_id", "=", U).execute(); // transcripts cascade
}

async function runMagicDocState(): Promise<void> {
  // magic_doc_state, now content-addressed: writeMagicDoc persists last_content_hash
  // + state_json (title/chars); isMagicDocStale is gated on (a) never-seen, (b) the
  // file's content drifting from the stored hash, and (c) the refresh interval.
  // refreshMagicDocs enumerates marker files under roots and skips fresh ones with
  // no LLM call. All deterministic (no provider needed).
  const db = getKysely();
  const dir = join(tmpdir(), `nomos-eval-magicdoc-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const fp = join(dir, "doc.md");
  const body = "<!-- MAGIC DOC: Eval Doc -->\n\n# Eval Doc\n\nInitial content.\n";
  await writeFile(fp, body, "utf-8");
  await db.deleteFrom("magic_doc_state").where("file_path", "=", fp).execute();

  // (a) never-seen -> stale
  check("[magic-doc] a never-seen doc is stale", (await isMagicDocStale(fp)) === true);

  // writeMagicDoc writes the file + records hash + metadata.
  await writeMagicDoc(fp, body);
  const row = await db
    .selectFrom("magic_doc_state")
    .select(["state_json", "last_content_hash"])
    .where("file_path", "=", fp)
    .executeTakeFirst();
  check(
    "[magic-doc] writeMagicDoc populates last_content_hash (64-hex sha256)",
    row != null && typeof row.last_content_hash === "string" && row.last_content_hash.length === 64,
  );
  check(
    "[magic-doc] state_json round-trips as an object (title/chars), not a string",
    row != null &&
      typeof row.state_json === "object" &&
      row.state_json !== null &&
      (row.state_json as Record<string, unknown>).title === "Eval Doc",
  );

  // (c) content unchanged + just updated -> not stale
  check("[magic-doc] a just-written, unchanged doc is not stale", !(await isMagicDocStale(fp)));

  // (b) content drifts on disk -> stale immediately (hash mismatch), regardless of time
  await writeFile(fp, body + "\nEdited by hand.\n", "utf-8");
  check("[magic-doc] an edited doc (hash mismatch) is stale", await isMagicDocStale(fp));

  // restore content; backdate the row past the interval -> time-based refresh fires
  await writeFile(fp, body, "utf-8");
  check(
    "[magic-doc] restored content matches the stored hash (not stale)",
    !(await isMagicDocStale(fp)),
  );
  await db
    .updateTable("magic_doc_state")
    .set({ last_updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where("file_path", "=", fp)
    .execute();
  check(
    "[magic-doc] unchanged content past the interval is stale (periodic refresh)",
    await isMagicDocStale(fp),
  );

  // markMagicDocUpdated with no hash leaves the column null (back-compat path).
  await markMagicDocUpdated(fp);
  const noHash = await db
    .selectFrom("magic_doc_state")
    .select("last_content_hash")
    .where("file_path", "=", fp)
    .executeTakeFirst();
  check(
    "[magic-doc] markMagicDocUpdated() without a hash clears last_content_hash",
    noHash != null && noHash.last_content_hash === null,
  );

  // refreshMagicDocs runner: enumerate the dir, find the one marker file, skip it
  // (fresh after writeMagicDoc) with no LLM call; a plain .md is ignored.
  await writeMagicDoc(fp, body); // make it fresh again
  await writeFile(join(dir, "plain.md"), "# not a magic doc\n", "utf-8");
  const summary = await refreshMagicDocs([dir]);
  check(
    "[magic-doc] refreshMagicDocs finds only the marker file (ignores plain .md)",
    summary.scanned === 1,
  );
  check(
    "[magic-doc] refreshMagicDocs skips a fresh doc (no refresh, no failure)",
    summary.refreshed === 0 && summary.skipped === 1 && summary.failed === 0,
  );

  if (!KEEP) {
    await db.deleteFrom("magic_doc_state").where("file_path", "=", fp).execute();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runAutoDreamDeep(): Promise<void> {
  // Deeper auto-dream: the shouldConsolidate time + turn gates, and Phase-2
  // near-duplicate merge (cosine > 0.92 on real embeddings). All deterministic.
  const db = getKysely();

  // ── gates (shouldConsolidate reads the auto_dream_state singleton) ──
  const setState = async (lastRunAt: Date | null, lastTurnCount: number) => {
    await db.deleteFrom("auto_dream_state").execute();
    if (lastRunAt) {
      await db
        .insertInto("auto_dream_state")
        .values({ id: 1, last_run_at: lastRunAt, last_turn_count: lastTurnCount, total_runs: 0 })
        .execute();
    }
  };
  await setState(new Date(), 0); // ran just now
  check(
    "[auto-dream] time gate blocks a run within the interval",
    (await shouldConsolidate(10_000)) === false,
  );
  await setState(new Date(Date.now() - 2 * 60 * 60 * 1000), 0); // 2h ago
  check("[auto-dream] turn gate blocks < 10 new turns", (await shouldConsolidate(9)) === false);
  check(
    "[auto-dream] runs once the interval passed + >= 10 new turns",
    (await shouldConsolidate(10)) === true,
  );
  await setState(null, 0); // no state row
  check(
    "[auto-dream] with no prior state the time gate is skipped (turn gate only)",
    (await shouldConsolidate(10)) === true,
  );

  // ── Phase 2: near-duplicate merge on real 768-d embeddings ──
  const U = "eval-dream-merge";
  const vec = (second: number) => {
    const v = Array.from({ length: 768 }, () => 0);
    v[0] = 1;
    v[1] = second;
    return v;
  };
  await storeMemoryChunk({
    id: `${U}:a`,
    userId: U,
    source: "test",
    text: "user likes oat milk flat whites",
    embedding: vec(0),
    metadata: { category: "fact" },
  });
  await storeMemoryChunk({
    id: `${U}:b`,
    userId: U,
    source: "test",
    text: "the user drinks oat-milk flat whites",
    embedding: vec(0.05),
    metadata: { category: "fact" },
  });
  await recordMemoryAccess(U, [`${U}:a`]); // a kept (higher access)
  const res = await consolidateMemory(U);
  check("[auto-dream] Phase 2 merges near-duplicate chunks (cosine > 0.92)", res.merged === 1);
  const survivors = await db
    .selectFrom("memory_chunks")
    .select(["id", "access_count"])
    .where("user_id", "=", U)
    .where("id", "in", [`${U}:a`, `${U}:b`])
    .execute();
  check(
    "[auto-dream] the higher-access chunk survives with combined access_count",
    survivors.length === 1 && survivors[0]!.id === `${U}:a` && survivors[0]!.access_count === 1,
  );

  if (!KEEP) {
    await db.deleteFrom("memory_chunks").where("user_id", "=", U).execute();
    await db.deleteFrom("auto_dream_state").execute();
  } else {
    // This test's gate cases churn the auto_dream_state singleton to empty. Leave
    // a canonical row (via the real autoDream path) so a --keep inspection of
    // nomos_eval reflects production, which always holds the singleton.
    await db.deleteFrom("auto_dream_state").execute();
    await autoDream(10, async () => ({ merged: 2, pruned: 1, newChunks: 3, durationMs: 0 }));
  }
}

// ── helpers ──

async function seedOrgMembers(ids: string[]): Promise<void> {
  // The hosted interceptor gates on org membership; seed the test tenants.
  const db = getKysely();
  await db
    .executeQuery(
      sql`CREATE TABLE IF NOT EXISTS org_members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', added_at TIMESTAMPTZ NOT NULL DEFAULT now())`.compile(
        db,
      ),
    )
    .catch(() => undefined);
  for (const id of ids) {
    await db.executeQuery(
      sql`INSERT INTO org_members (user_id, role) VALUES (${id}, 'member') ON CONFLICT (user_id) DO NOTHING`.compile(
        db,
      ),
    );
  }
}

async function removeOrgMembers(ids: string[]): Promise<void> {
  const db = getKysely();
  for (const id of ids) {
    await db
      .executeQuery(sql`DELETE FROM org_members WHERE user_id = ${id}`.compile(db))
      .catch(() => undefined);
  }
}

async function upsertModel(userId: string, key: string, value: string): Promise<void> {
  const { upsertUserModel } = await import("../src/db/user-model.ts");
  await upsertUserModel({
    userId,
    category: "preference",
    key,
    value,
    sourceIds: [],
    confidence: 0.9,
  });
}

/**
 * Seed a realistic personal "brain" for a user: a profile, several people notes
 * with real detail, a project, a procedure, contacts, and a couple of user-model
 * preferences. Gives the wiki compiler something substantial to distil, and leaves
 * inspectable content in the kept DB (vault_notes + contacts + user_model).
 */
async function seedRichVault(userId: string): Promise<void> {
  await vaultWrite(
    userId,
    "profile.md",
    "I'm a staff engineer at Acme on the Platform team. I care about reliability, prefer async-first communication, and run a weekly architecture review on Wednesdays.",
    { title: "Profile" },
  );
  await vaultWrite(
    userId,
    "people/dana.md",
    "Dana Smith is the VP of Engineering at Acme. She leads the Platform org, prefers async standups, and approves any infra spend over $10k. We met at the 2023 offsite.",
    { title: "Dana Smith" },
  );
  await vaultWrite(
    userId,
    "people/raj.md",
    "Raj Patel is a Senior PM on the Payments team and owns the billing roadmap. He is vegetarian and allergic to peanuts, so pick restaurants accordingly. He drives the [[Project Atlas]] requirements.",
    { title: "Raj Patel" },
  );
  await vaultWrite(
    userId,
    "people/maya.md",
    "Maya Chen is a staff SRE who owns the on-call rotation and the incident process. Loop her in for anything production-impacting.",
    { title: "Maya Chen" },
  );
  await vaultWrite(
    userId,
    "projects/atlas.md",
    "Project Atlas is the billing migration off the legacy invoicing system, targeting Q3. [[Raj Patel]] owns requirements; the current blocker is the Stripe webhook reconciliation work, and [[Dana Smith]] is the exec sponsor.",
    { title: "Project Atlas" },
  );
  await vaultWrite(
    userId,
    "procedures/inbox.md",
    "Inbox triage: archive newsletters, flag anything from Dana or Raj, draft replies for review on threads I own, and snooze anything not actionable this week.",
    { title: "Inbox triage" },
  );
  await createContact(userId, { displayName: "Dana Smith" });
  await createContact(userId, { displayName: "Raj Patel" });
  await createContact(userId, { displayName: "Maya Chen" });
  await upsertModel(userId, "communication_style", "async-first");
  await upsertModel(userId, "meeting_cadence", "weekly architecture review on Wednesdays");
}

/**
 * Bulk-remove every per-user row for a SYNTHETIC test tenant. GUARDED so it can
 * never wipe the real local owner: hosted synthetic tenants (eval-alice/eval-bob)
 * only ever hold test data, but `local` is the user's actual brain.
 */
async function purgeSyntheticTenant(uid: string): Promise<void> {
  if (uid === "local" || uid === resolveMemoryUserId("local")) {
    throw new Error(
      `refusing to bulk-purge the real local owner via purgeSyntheticTenant("${uid}")`,
    );
  }
  const db = getKysely();
  await db.deleteFrom("memory_chunks").where("user_id", "=", uid).execute();
  await db.deleteFrom("vault_notes").where("user_id", "=", uid).execute();
  await db.deleteFrom("user_model").where("user_id", "=", uid).execute();
  await db.deleteFrom("contacts").where("user_id", "=", uid).execute();
}

/**
 * Surgically remove ONLY the specific artifacts a test created. Safe under any
 * owner including the real local one, because it deletes by exact note path /
 * chunk id / model key / contact id, never by `user_id` alone. `deleteMemoryByPath`
 * also catches the note's fire-and-forget vector chunk that may land after the
 * vault delete.
 */
async function purgeArtifacts(
  uid: string,
  a: { notePath?: string; chunkId?: string; modelKey?: string; contactId?: string },
): Promise<void> {
  const db = getKysely();
  if (a.notePath) {
    await vaultDelete(uid, a.notePath).catch(() => undefined);
    await deleteMemoryByPath(uid, a.notePath).catch(() => undefined);
  }
  if (a.chunkId)
    await db
      .deleteFrom("memory_chunks")
      .where("user_id", "=", uid)
      .where("id", "=", a.chunkId)
      .execute();
  if (a.modelKey) {
    await db
      .deleteFrom("user_model")
      .where("user_id", "=", uid)
      .where("category", "=", "preference")
      .where("key", "=", a.modelKey)
      .execute();
  }
  if (a.contactId)
    await db
      .deleteFrom("contacts")
      .where("user_id", "=", uid)
      .where("id", "=", a.contactId)
      .execute();
}

/**
 * Final settle-and-sweep: vault writes index into the vector store fire-and-forget,
 * so a chunk can land after a per-test cleanup. Re-sweep the known test artifacts
 * after a short delay. Surgical for `local`, guarded-bulk for synthetic tenants.
 */
async function finalSweep(): Promise<void> {
  await new Promise((r) => setTimeout(r, 600));
  await purgeArtifacts("local", {
    notePath: "eval-tmp/facts.md",
    chunkId: "eval-tmp:local:c1",
    modelKey: "eval_tmp_editor",
  });
  await purgeArtifacts("local", { notePath: "eval-tmp/wire-note.md" });
  await purgeSyntheticTenant("eval-alice").catch(() => undefined);
  await purgeSyntheticTenant("eval-bob").catch(() => undefined);
  await removeOrgMembers(["eval-alice", "eval-bob"]);
  await getKysely()
    .deleteFrom("sessions")
    .where("session_key", "like", "eval:%")
    .execute()
    .catch(() => undefined);
  await getKysely()
    .deleteFrom("sessions")
    .where("session_key", "=", "terminal:ephemeral:eval-chat")
    .execute()
    .catch(() => undefined);
}

const TEST_DB_NAME = "nomos_eval";

/** Maintenance-db admin URL (cannot CREATE/DROP a database while connected to it). */
function adminUrlFrom(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

/**
 * Provision a throwaway, freshly-migrated database and point the process at it,
 * the same way hosted provisions a per-customer DB. This makes the eval hermetic:
 * it never reads or writes the dev `nomos` DB, so a bug in cleanup can't touch real
 * data. Returns the original DATABASE_URL for teardown.
 */
async function setupTestDb(): Promise<{ baseUrl: string }> {
  const baseUrl = process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos";
  if (new URL(baseUrl).pathname === `/${TEST_DB_NAME}`) {
    throw new Error(`DATABASE_URL already points at the test db ${TEST_DB_NAME}; refusing to run`);
  }
  const admin = postgres(adminUrlFrom(baseUrl), { max: 1, onnotice: () => {} });
  try {
    await dropDatabase(admin, TEST_DB_NAME); // clean any orphan from a crashed run
    await createDatabase(admin, TEST_DB_NAME);
  } finally {
    await admin.end();
  }
  process.env.DATABASE_URL = withDatabaseName(baseUrl, TEST_DB_NAME);
  await runMigrations(); // applies schema.sql to the fresh DB (pgvector/pg_trgm + tables)
  // eslint-disable-next-line no-console
  console.log(`Provisioned isolated test DB: ${TEST_DB_NAME}\n`);
  return { baseUrl };
}

/** Drop the test DB via an admin connection. Caller must have closed the app pool. */
async function dropTestDb(baseUrl: string): Promise<void> {
  const admin = postgres(adminUrlFrom(baseUrl), { max: 1, onnotice: () => {} });
  try {
    await dropDatabase(admin, TEST_DB_NAME); // WITH FORCE also kills stragglers
  } finally {
    await admin.end();
  }
  // eslint-disable-next-line no-console
  console.log(`Dropped test DB: ${TEST_DB_NAME}`);
}

async function teardownTestDb(baseUrl: string): Promise<void> {
  await closeDb(); // detach the app pool before DROP
  await dropTestDb(baseUrl);
}

/** Where a `--keep` run drops its test results so a later `--audit` can cross-check them. */
const RESULTS_FILE = join(tmpdir(), "nomos-eval-results.json");

function printSummary(): void {
  const failed = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skipped);
  // eslint-disable-next-line no-console
  console.log(
    `\n${failed.length === 0 ? "OK" : "FAIL"}: ${results.length - skipped.length} ran, ` +
      `${failed.length} failed, ${skipped.length} skipped`,
  );
  if (failed.length > 0) process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");

  // `--clean`: just drop a previously kept test DB and exit (tidy up after --keep).
  if (args.includes("--clean")) {
    await dropTestDb(process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos");
    return;
  }

  // `--audit-kept`: STANDALONE audit of a DB a prior `--keep` run left behind --
  // connect to that persisted nomos_eval (never recreate/migrate it), load the kept
  // test labels, run the Opus-4.8 / xhigh audit, then drop it (clean). For
  // inspect-then-audit; the default `--audit` does eval+audit in one run instead.
  if (AUDIT_KEPT) {
    const baseUrl = process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos";
    if (new URL(baseUrl).pathname === `/${TEST_DB_NAME}`) {
      throw new Error(`DATABASE_URL already points at ${TEST_DB_NAME}; refusing to run`);
    }
    process.env.DATABASE_URL = withDatabaseName(baseUrl, TEST_DB_NAME); // point at the kept DB
    // eslint-disable-next-line no-console
    console.log(`Auditing kept test DB: ${TEST_DB_NAME} (Opus 4.8, xhigh)\n`);

    let priorLabels: string[] = [];
    try {
      const raw = JSON.parse(await readFile(RESULTS_FILE, "utf-8")) as Result[];
      priorLabels = raw.filter((r) => r.pass && !r.skipped).map((r) => r.label);
    } catch {
      // eslint-disable-next-line no-console
      console.log(
        "No kept results found -- run `pnpm eval:agent --keep` first. Auditing DB content without test labels.",
      );
    }

    try {
      await runModelDbAudit(priorLabels);
      await runSpecAudit();
    } finally {
      if (keep) await closeDb();
      else await teardownTestDb(baseUrl);
    }
    printSummary();
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Agent eval (LLM judge: ${hasLLM ? "on" : "off"}${AUDIT ? "; --audit (eval+audit+clean)" : keep ? "; --keep" : ""})\n`,
  );
  const { baseUrl } = await setupTestDb();
  try {
    // Phase 1 -- eval: every deterministic check, against the fresh nomos_eval.
    await runEval();
    // Phase 2 -- audit (same run): the Opus-4.8 / xhigh pass reads the just-written,
    // committed nomos_eval and cross-checks it against this run's passing labels.
    if (AUDIT) {
      const passed = results.filter((r) => r.pass && !r.skipped).map((r) => r.label);
      await runModelDbAudit(passed);
      // Spec audit: reason DB + wiring against the independent feature manifest,
      // catching dormant code + missing effects the label audit can't see.
      await runSpecAudit();
    }
  } finally {
    // Phase 3 -- clean (or keep). --audit drops the DB unless --keep is also given.
    if (keep) {
      // Persist the results so `--audit-kept` can cross-check a manually-kept DB.
      await writeFile(RESULTS_FILE, JSON.stringify(results), "utf-8").catch(() => undefined);
      await closeDb();
      // eslint-disable-next-line no-console
      console.log(
        `\nKept test DB. Inspect: psql "${process.env.DATABASE_URL}"\n  audit it:  pnpm eval:agent --audit-kept\n  drop it:   pnpm eval:agent --clean`,
      );
    } else {
      // The throwaway DB is dropped wholesale, so per-row cleanup is belt-and-braces.
      await finalSweep().catch(() => undefined);
      await teardownTestDb(baseUrl);
    }
  }

  printSummary();
}

/**
 * Dump the rows the recent work writes, exposing jsonb_typeof for every jsonb
 * column. A type of 'string' (instead of 'object'/'array') is the signature of
 * the double-encoding bug class -- the boolean `typeof === "object"` checks can
 * pass for the wrong reason, but jsonb_typeof from Postgres is ground truth.
 */
async function dumpDbForAudit(): Promise<Record<string, unknown[]>> {
  const db = getKysely();
  const q = async (label: string, text: string): Promise<[string, unknown[]]> => {
    try {
      const res = await db.executeQuery(sql`${sql.raw(text)}`.compile(db));
      return [label, res.rows as unknown[]];
    } catch (err) {
      return [label, [{ error: err instanceof Error ? err.message : String(err) }]];
    }
  };
  const pairs = await Promise.all([
    q(
      "auto_dream_state",
      `SELECT id, last_turn_count, total_runs, jsonb_typeof(state_json) AS state_json_type, state_json FROM auto_dream_state`,
    ),
    q(
      "magic_doc_state",
      `SELECT file_path, last_content_hash, jsonb_typeof(state_json) AS state_json_type, state_json FROM magic_doc_state LIMIT 20`,
    ),
    q(
      "style_profiles",
      `SELECT user_id, scope, jsonb_typeof(profile) AS profile_type, profile, sample_count FROM style_profiles ORDER BY user_id, scope LIMIT 30`,
    ),
    q(
      "user_model",
      `SELECT user_id, category, key, jsonb_typeof(value) AS value_type, value, confidence, source_ids FROM user_model ORDER BY user_id LIMIT 30`,
    ),
    q(
      "commitments",
      `SELECT user_id, description, deadline, status, reminded, source_msg FROM commitments ORDER BY user_id LIMIT 30`,
    ),
    q(
      "sessions",
      `SELECT session_key, model, jsonb_typeof(metadata) AS metadata_type, metadata->>'sdkSessionId' AS sdk_session_id FROM sessions ORDER BY session_key LIMIT 30`,
    ),
    q(
      "ingest_jobs",
      `SELECT platform, run_type, delta_schedule, delta_enabled FROM ingest_jobs LIMIT 20`,
    ),
    q(
      "transcript_messages",
      `SELECT session_id, role, jsonb_typeof(usage) AS usage_type, usage, jsonb_typeof(content) AS content_type FROM transcript_messages ORDER BY id DESC LIMIT 20`,
    ),
    q(
      "memory_chunks",
      `SELECT user_id, source, jsonb_typeof(metadata) AS metadata_type, metadata->>'category' AS category FROM memory_chunks ORDER BY user_id LIMIT 20`,
    ),
    q(
      "wiki_articles",
      `SELECT user_id, path, title, jsonb_typeof(to_jsonb(backlinks)) AS backlinks_type FROM wiki_articles ORDER BY user_id LIMIT 20`,
    ),
  ]);
  return Object.fromEntries(pairs);
}

/**
 * Opus-4.8-with-thinking audit: hand the model the deterministic test results AND
 * the real database content, and have it independently confirm the rows actually
 * support each claim -- the cross-check the boolean assertions can't do alone.
 * Runs only under `--audit` (which keeps the data) and when an LLM is configured.
 */
async function runModelDbAudit(passedLabels: string[]): Promise<void> {
  if (!hasLLM) {
    skip(
      "[db-audit] Opus 4.8 (thinking) confirms DB content matches the test results",
      "no LLM provider",
    );
    return;
  }
  // auto_dream_state is an instance-wide singleton that later gate tests churn to
  // empty. Re-establish a canonical row through the REAL write path (autoDream ->
  // saveState) so the audit has current, production-encoded evidence to verify.
  await getKysely().deleteFrom("auto_dream_state").execute();
  await autoDream(10, async () => ({ merged: 2, pruned: 1, newChunks: 3, durationMs: 0 }));

  const dump = await dumpDbForAudit();

  // Deterministic first: a dump query only errors when a column it references is
  // missing -- i.e. the live DB drifted from what the code expects (the exact
  // class of bug a fresh-DB eval can't see). Catch it without spending the LLM.
  const errored = Object.entries(dump)
    .filter(([, rows]) => rows.some((r) => r != null && typeof r === "object" && "error" in r))
    .map(([t]) => t);
  check(
    "[db-audit] every audited table + column exists (no schema drift)",
    errored.length === 0,
    errored.length ? `missing/errored: ${errored.join(", ")}` : undefined,
  );

  const passed = passedLabels;

  const prompt = `You are a meticulous database auditor. An eval suite just ran a set of deterministic checks against this PostgreSQL database and they all reported PASS. Your job is to INDEPENDENTLY verify, from the actual table contents below, that the database genuinely supports those claims -- and to catch anything the boolean assertions could have missed.

PASSING TEST LABELS:
${passed.map((l) => `- ${l}`).join("\n")}

ACTUAL DATABASE CONTENT (jsonb_typeof exposes how each jsonb column is really stored):
${JSON.stringify(dump, null, 2)}

Verify rigorously and think step by step:
1. DOUBLE-ENCODING: every *_type field for a jsonb object/array column MUST be "object" or "array". If any is "string", the value was double-encoded (JSON.stringify'd into jsonb) -- a real bug a "typeof === object" JS check would NOT catch. Call it out.
2. PER-USER SCOPING: style_profiles / user_model / commitments / memory_chunks / wiki_articles rows must carry distinct user_id values where multiple owners were seeded; no row should leak another owner's data.
3. EXPECTED CONTENT: the rows should be consistent with the passing labels (e.g. a passing "state_json round-trips as an object" implies auto_dream_state.state_json_type = "object").
4. MISSING DATA: note any passing claim that has NO supporting row in the dump.

End your answer with EXACTLY one final line:
"AUDIT: PASS" if every check holds, or
"AUDIT: FAIL — <comma-separated concrete reasons>" otherwise.`;

  const { text } = await runForkedAgent({
    prompt,
    model: "claude-opus-4-8",
    thinking: { type: "adaptive" },
    effort: "xhigh", // ultracode-level reasoning for the audit
    label: "db-audit",
    maxTurns: 1,
  });

  const verdictLine =
    text
      .split("\n")
      .reverse()
      .find((l) => /AUDIT:/i.test(l)) ?? text.slice(-300);
  const pass = /AUDIT:\s*PASS/i.test(text) && !/AUDIT:\s*FAIL/i.test(text);
  check(
    "[db-audit] Opus 4.8 (thinking) confirms DB content matches the test results",
    pass,
    verdictLine.trim(),
  );
}

// ── Spec-driven audit ────────────────────────────────────────────────────────
// The label audit above asks "does the DB back the PASSING TEST LABELS?" -- but
// the labels share the tests' blind spots, so a feature/column no test asserts is
// invisible to it. The spec audit instead reasons against an INDEPENDENT target:
// eval/feature-manifest.ts states, per feature, what should be wired and what it
// should produce. That lets it catch the three classes regression tests miss:
// dormant code (no live caller), empty outputs (a declared effect never lands),
// and drift. See runSpecAudit at the bottom of this block.

type LivenessSite = { symbol: string; wired: boolean; sites: string[] };
type FeatureLiveness = { id: string; wired: boolean; symbols: LivenessSite[] };
type EffectEvidence = {
  feature: string;
  claim: string;
  notExercised: boolean;
  count?: number;
  expect?: "nonzero" | "zero";
  /** Authoritative deterministic pass/fail (respects `expect`); the LLM must trust this. */
  ok?: boolean;
  doubleEncoded?: { bad: number; total: number };
  error?: string;
};

/**
 * Lines in `src` that reference `symbol` (working tree). `--untracked` so a new,
 * not-yet-committed file still counts as a caller -- otherwise a feature wired by
 * an untracked file is falsely flagged DORMANT during development.
 */
function gitGrep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", "--untracked", ...args, "--", "src"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // git grep exits 1 when there are no matches
  }
}

/**
 * A symbol is "wired" if some non-test source line references it that is NOT its
 * own definition and NOT a barrel re-export -- i.e. a real import/call site. This
 * is the deterministic dead-code signal: the dormant features we hit by hand had
 * only a definition (+ a barrel), zero call sites.
 */
function classifyLiveness(symbol: string): LivenessSite {
  const def = new RegExp(
    `export\\s+(async\\s+)?(function|const|let|class|interface|type)\\s+${symbol}\\b`,
  );
  const barrel = /export\s*(\{[^}]*\}|\*)\s*from/;
  const sites = gitGrep(["-n", "-w", symbol]).filter((line) => {
    const path = line.slice(0, line.indexOf(":"));
    if (path.endsWith(".test.ts")) return false;
    if (def.test(line)) return false;
    if (barrel.test(line)) return false;
    return true;
  });
  return { symbol, wired: sites.length > 0, sites: sites.slice(0, 3) };
}

/** Files under `src` that mention a token (used to locate cron handlers + seeders). */
function filesMentioning(token: string): string[] {
  return gitGrep(["-l", token]);
}

/**
 * Meta-check: keep the manifest and the running system in lockstep. Every cron
 * sentinel handled in cron-engine MUST be declared here (so a new background
 * feature can't ship without a contract), and every declared cron sentinel must
 * be BOTH handled and seeded somewhere outside cron-engine -- a handler that is
 * never seeded is the exact "code exists but never runs" dormancy that bit us.
 */
async function runSentinelMetaCheck(): Promise<void> {
  const engine = "src/daemon/cron-engine.ts";
  // Parse the sentinels the engine actually dispatches on (=== "__x__" / startsWith).
  const engineText = await readFile(engine, "utf-8");
  const handled = new Set<string>();
  for (const m of engineText.matchAll(/(?:===\s*"|startsWith\(")(__[a-z_]+__)/g)) handled.add(m[1]);

  // Several features can legitimately share a sentinel (e.g. value-reflection +
  // stale-decay both ride the __auto_dream__ cron), so collect the set of declared
  // sentinels AND the full per-feature list -- don't dedupe, or a feature loses its
  // own handled/seeded check.
  const declared = new Set<string>();
  const cronFeatures: { id: string; sentinel: string }[] = [];
  for (const f of FEATURES) {
    if (f.trigger.kind === "cron") {
      declared.add(f.trigger.sentinel);
      cronFeatures.push({ id: f.id, sentinel: f.trigger.sentinel });
    }
  }

  const undeclared = [...handled].filter((s) => !declared.has(s));
  check(
    "[spec] every cron sentinel handled in cron-engine has a manifest entry",
    undeclared.length === 0,
    undeclared.length
      ? `undeclared background features: ${undeclared.join(", ")}`
      : `${handled.size} sentinels declared`,
  );

  for (const { id, sentinel } of cronFeatures) {
    const refs = filesMentioning(sentinel);
    const inEngine = refs.includes(engine);
    const seeder = refs.find((p) => p !== engine);
    check(
      `[spec] ${id}: cron handled + seeded (not dormant)`,
      inEngine && !!seeder,
      !inEngine
        ? "no handler in cron-engine"
        : !seeder
          ? "handler present but the sentinel is NEVER seeded -- dormant cron"
          : `handled + seeded in ${seeder}`,
    );
  }
}

/**
 * Run each effect's deterministic SQL against the populated nomos_eval. Exercised
 * effects become hard checks (an empty result is a real gap); `notExercised`
 * effects are recorded as evidence only (the eval doesn't drive them, so absence
 * is a coverage note, not a failure). The double-encode guard flags only jsonb
 * strings whose text is itself JSON, so scalar values never false-positive.
 */
async function runEffectChecks(): Promise<EffectEvidence[]> {
  const db = getKysely();
  const scalar = async (q: string): Promise<number | { error: string }> => {
    try {
      const res = await db.executeQuery(sql`${sql.raw(q)}`.compile(db));
      const row = res.rows[0] as Record<string, unknown> | undefined;
      return Number((row ? Object.values(row)[0] : 0) ?? 0);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const evidence: EffectEvidence[] = [];
  for (const f of FEATURES) {
    for (const e of f.effects) {
      const ev: EffectEvidence = { feature: f.id, claim: e.claim, notExercised: !!e.notExercised };

      if (e.sql) {
        const c = await scalar(e.sql.query);
        ev.expect = e.sql.expect;
        if (typeof c === "number") {
          ev.count = c;
          const ok = e.sql.expect === "nonzero" ? c > 0 : c === 0;
          ev.ok = ok;
          if (!e.notExercised)
            check(`[spec] ${f.id}: ${e.claim}`, ok, `count=${c} (expect ${e.sql.expect})`);
        } else {
          ev.error = c.error;
          ev.ok = false;
          if (!e.notExercised) check(`[spec] ${f.id}: ${e.claim}`, false, c.error);
        }
      }

      if (e.noDoubleEncode) {
        const { table, column, where } = e.noDoubleEncode;
        const w = where ? `WHERE ${where}` : "";
        // Double-encode signature: a jsonb STRING whose text starts with { or [.
        const q = `SELECT count(*) FILTER (WHERE jsonb_typeof(${column}) = 'string' AND ltrim(${column} #>> '{}') ~ '^[{[]') AS bad, count(*) AS total FROM ${table} ${w}`;
        try {
          const res = await db.executeQuery(sql`${sql.raw(q)}`.compile(db));
          const row = res.rows[0] as { bad: string; total: string } | undefined;
          const bad = Number(row?.bad ?? 0);
          const total = Number(row?.total ?? 0);
          ev.doubleEncoded = { bad, total };
          check(
            `[spec] ${f.id}: ${table}.${column} not double-encoded`,
            bad === 0,
            bad > 0
              ? `${bad}/${total} rows are JSON.stringify'd into jsonb`
              : `${total} rows clean`,
          );
        } catch (err) {
          check(
            `[spec] ${f.id}: ${table}.${column} not double-encoded`,
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      evidence.push(ev);
    }
  }
  return evidence;
}

/**
 * Opus-4.8 / xhigh reasoning pass against the manifest. Unlike the label audit,
 * its reference is INTENT: for each feature it weighs the declared effects against
 * the liveness + effect evidence (which already carries per-column double-encode
 * counts), and flags dormant code, effects that should have landed but didn't,
 * double-encoding, and drift. The forked call is wrapped so an audit-fork failure
 * is reported as a check -- it must never crash the eval after the real work ran.
 */
async function runSpecReasoning(
  liveness: FeatureLiveness[],
  effects: EffectEvidence[],
): Promise<void> {
  const LABEL = "[spec-audit] Opus 4.8 (thinking) reasons DB + wiring against the feature manifest";
  if (!hasLLM) {
    skip(LABEL, "no LLM provider");
    return;
  }
  const manifestView = FEATURES.map((f) => ({
    id: f.id,
    summary: f.summary,
    trigger: f.trigger,
    entry: f.entry,
    effects: f.effects.map((e) => ({ claim: e.claim, exercised: !e.notExercised })),
    invariants: f.invariants ?? [],
  }));

  const prompt = `You are auditing an agent system against its FEATURE MANIFEST -- an independent contract of what each feature should do and produce. Everything you need is provided below as structured evidence. Do NOT use any tools and do NOT try to read files or the codebase; judge ONLY from the evidence here, and reply in a SINGLE message ending with the verdict line.

FEATURE MANIFEST (the target/expected behavior):
${JSON.stringify(manifestView, null, 2)}

LIVENESS EVIDENCE (static call-site search; a feature with no live caller is dead code):
${JSON.stringify(liveness, null, 2)}

EFFECT EVIDENCE (deterministic SQL against the populated DB. count = rows matching the query; "expect" is the required direction ("nonzero" = the effect should be present; "zero" = the query counts a BAD condition and must be 0); "ok" is the AUTHORITATIVE deterministic pass/fail that already respects "expect" -- TRUST IT. "notExercised" are behavioral and the eval does not drive them, so absence is EXPECTED. doubleEncoded.bad>0 means a jsonb column was JSON.stringify'd):
${JSON.stringify(effects, null, 2)}

Reason per feature, then judge:
1. DORMANT: a feature with no live call site, or a cron sentinel handled but never seeded, runs in no real path. Flag it.
2. MISSING EFFECT: an EXERCISED effect (notExercised=false) FAILS only when ok=false. Do NOT infer pass/fail from count yourself -- a count=0 with expect="zero" is a PASS (ok=true), and a small nonzero count with expect="nonzero" is fine. Flag an effect only if ok=false.
3. DOUBLE-ENCODING: any effect with doubleEncoded.bad>0 is a real storage bug. Flag it.
4. DRIFT: note anything inconsistent with a feature's declared intent or per-owner isolation.

End with EXACTLY one final line:
"SPEC-AUDIT: PASS" if every declared feature is wired and every exercised effect is supported, or
"SPEC-AUDIT: FAIL: <comma-separated concrete reasons>" otherwise.`;

  let text: string;
  try {
    ({ text } = await runForkedAgent({
      prompt,
      model: "claude-opus-4-8",
      thinking: { type: "adaptive" },
      effort: "xhigh",
      label: "spec-audit",
      maxTurns: 4, // xhigh thinking over a large prompt needs room to reach a terminal answer
    }));
  } catch (err) {
    // An audit fork that errors (e.g. transient SDK/turn-limit) must not crash the
    // eval after every deterministic spec check already ran. Surface it as a fail.
    check(
      LABEL,
      false,
      `spec-audit fork errored: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const verdictLine =
    text
      .split("\n")
      .reverse()
      .find((l) => /SPEC-AUDIT:/i.test(l)) ?? text.slice(-300);
  const pass = /SPEC-AUDIT:\s*PASS/i.test(text) && !/SPEC-AUDIT:\s*FAIL/i.test(text);
  check(LABEL, pass, verdictLine.trim());
}

/**
 * Spec-driven audit entry point: deterministic liveness + sentinel meta-check +
 * effect/invariant SQL, then the Opus/xhigh reasoning pass over the manifest.
 * Reasons against an independent target, so it catches dead code + missing
 * outputs that no test asserts -- the gap the label audit can't see.
 */
async function runSpecAudit(): Promise<void> {
  // 1. Liveness (deterministic): every manifest feature must have a live caller.
  const liveness: FeatureLiveness[] = FEATURES.map((f) => {
    const symbols = f.entry.map(classifyLiveness);
    return { id: f.id, wired: symbols.some((s) => s.wired), symbols };
  });
  for (const l of liveness) {
    const dormant = l.symbols.filter((s) => !s.wired).map((s) => s.symbol);
    check(
      `[spec] ${l.id}: has a live production caller`,
      l.wired,
      l.wired
        ? dormant.length
          ? `wired; no caller for: ${dormant.join(", ")}`
          : "wired"
        : `DORMANT -- no call site for any of: ${FEATURES.find((f) => f.id === l.id)?.entry.join(", ")}`,
    );
  }

  // 2. Meta-check: manifest <-> cron-engine handlers <-> seeders.
  runSentinelMetaCheck();

  // 3. Effects + invariants (deterministic SQL on the populated DB).
  const effects = await runEffectChecks();

  // 4. Opus/xhigh reasoning against the declared intent.
  await runSpecReasoning(liveness, effects);
}

/**
 * Conversation memory must be SEMANTICALLY searchable, not FTS-only: prove that
 * indexConversationTurn embeds the chunks it writes. The live gRPC path indexes
 * fire-and-forget (so a raw DB scan can catch it mid-flight); awaiting the real
 * function here is the deterministic check that conversation recall is accurate.
 */
async function runConversationEmbedding(): Promise<void> {
  const path = "evalconv:embed";
  const incoming: IncomingMessage = {
    id: "conv-embed-1",
    platform: "evalconv",
    channelId: "embed",
    userId: "eval-conv-embed",
    content:
      "Remember the product launch is next Tuesday at the downtown loft, and Priya owns the demo.",
    timestamp: new Date(),
  };
  const outgoing: OutgoingMessage = {
    inReplyTo: "conv-embed-1",
    platform: "evalconv",
    channelId: "embed",
    content:
      "Got it: launch next Tuesday at the downtown loft, Priya on the demo. I'll remind you.",
  };
  await indexConversationTurn(incoming, outgoing);

  const db = getKysely();
  const res = await db.executeQuery(
    sql`SELECT count(*) AS total, count(embedding) AS embedded FROM memory_chunks WHERE path = ${path} AND source = 'conversation'`.compile(
      db,
    ),
  );
  const row = res.rows[0] as { total: string; embedded: string } | undefined;
  const total = Number(row?.total ?? 0);
  const embedded = Number(row?.embedded ?? 0);
  check(
    "[conversation] indexConversationTurn persists conversation chunks",
    total >= 1,
    `total=${total}`,
  );
  if (isEmbeddingAvailable()) {
    check(
      "[conversation] conversation chunks are embedded (semantic recall, not FTS-only)",
      total >= 1 && embedded === total,
      `${embedded}/${total} embedded`,
    );
  } else {
    skip(
      "[conversation] conversation chunks are embedded (semantic recall, not FTS-only)",
      "embeddings unavailable",
    );
  }
  if (!KEEP) await db.deleteFrom("memory_chunks").where("path", "=", path).execute();
}

/**
 * Relationship stats from ingested history: computeRelationshipStats was dormant
 * (no caller). refreshRelationshipStats now runs post-ingestion. Seed a contact +
 * ingested messages referencing its platform id, then assert the derived
 * frequency + message count land in the relationship jsonb.
 */
async function runRelationshipStats(): Promise<void> {
  const U = "eval-relstats";
  const { contact } = await resolveContact(U, "slack", "U_ING", "Ingested Person");

  const db = getKysely();
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < 6; i++) {
    const ts = new Date(base + i * 2 * 24 * 60 * 60 * 1000).toISOString(); // every 2 days
    await db
      .insertInto("memory_chunks")
      .values({
        id: `relstat:${i}`,
        user_id: U,
        source: "ingest",
        path: "slack/c",
        text: `ingested message ${i}`,
        // object passthrough -> jsonb (JSON.stringify would double-encode)
        metadata: { source: "ingest", contact: "U_ING", timestamp: ts } as unknown as string,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  const n = await refreshRelationshipStats(U);
  const row = await db
    .selectFrom("contacts")
    .select("relationship")
    .where("id", "=", contact.id)
    .executeTakeFirstOrThrow();
  const rel = (row.relationship ?? {}) as Record<string, unknown>;
  check("[relationship-stats] computeRelationshipStats wired post-ingest", n >= 1, `updated=${n}`);
  check(
    "[relationship-stats] ingested history yields message count + frequency",
    Number(rel.messageCount) >= 6 && typeof rel.frequency === "string",
    `relationship=${JSON.stringify(rel)}`,
  );

  if (!KEEP) {
    await db.deleteFrom("memory_chunks").where("user_id", "=", U).execute();
    await db.deleteFrom("contact_identities").where("user_id", "=", U).execute();
    await db.deleteFrom("contacts").where("user_id", "=", U).execute();
  }
}

/**
 * Exercise the TOOL_APPROVAL_POLICY gate (ToolApprovalChecker wired into the
 * PreToolUse hook): block_critical denies a critical tool, allows a safe one, and
 * disabled adds no gate. Deterministic -- no DB or LLM -- but proves the gate is
 * actually reachable end-to-end, not just unit-tested in isolation.
 */
async function runToolApprovalGate(): Promise<void> {
  const { buildSdkHooks } = await import("../src/hooks/sdk-adapter.ts");
  const fire = async (policy: "block_critical" | "disabled", command: string) => {
    const hooks = buildSdkHooks({ sessionKey: "eval-approval", approvalPolicy: policy });
    const cb = hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (!cb) return { gate: false as const };
    const out = await cb(
      { tool_name: "Bash", tool_input: { command } } as unknown as Parameters<typeof cb>[0],
      undefined as unknown as Parameters<typeof cb>[1],
      { signal: new AbortController().signal } as unknown as Parameters<typeof cb>[2],
    );
    return { gate: true as const, out };
  };

  const denied = await fire("block_critical", "rm -rf /tmp/eval-x");
  const decision =
    denied.gate &&
    (denied.out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
  check(
    "[tool-approval] block_critical denies a critical tool (rm -rf)",
    decision === "deny",
    `decision=${decision || "none"}`,
  );

  const safe = await fire("block_critical", "ls -la");
  check(
    "[tool-approval] block_critical allows a safe tool",
    safe.gate && JSON.stringify(safe.out) === JSON.stringify({ continue: true }),
  );

  const off = buildSdkHooks({ sessionKey: "eval-approval", approvalPolicy: "disabled" });
  check("[tool-approval] disabled policy adds no gate (zero-cost)", off === undefined);
}

/**
 * "Think Like You" tool bridge (/reflect, /calibrate, /dna): the nomos-think MCP
 * tools call these backends, which run on the instance owner's user_model. Seed a
 * pattern + value + preference, then exercise each backend end-to-end. Proves the
 * skills are wired to the documented logic (docs/think-like-you.md), not orphaned.
 */
async function runThinkTools(): Promise<void> {
  const { upsertUserModel } = await import("../src/db/user-model.ts");
  const { generateReflectionData } = await import("../src/memory/reflection.ts");
  const { analyzeCalibrationGaps, getNextScenario } = await import("../src/memory/calibration.ts");
  const { compileDNA } = await import("../src/memory/personality-dna.ts");

  const owner = resolveMemoryUserId(undefined);
  await upsertUserModel({
    userId: owner,
    category: "decision_pattern",
    key: "eval-think-ship",
    value: {
      text: "Ships first unless tech debt is actively causing bugs",
      context: "prioritization",
    },
    sourceIds: [],
    confidence: 0.8,
  });
  await upsertUserModel({
    userId: owner,
    category: "value",
    key: "eval-think-reliability",
    value: { text: "Reliability over features" },
    sourceIds: [],
    confidence: 0.85,
  });
  await upsertUserModel({
    userId: owner,
    category: "preference",
    key: "eval-think-pnpm",
    value: { text: "pnpm not npm" },
    sourceIds: [],
    confidence: 0.9,
  });

  const r = await generateReflectionData();
  check(
    "[think] /reflect backend returns synthesis + predictions + blind spots",
    !!r &&
      typeof r.synthesis === "object" &&
      Array.isArray(r.predictions) &&
      Array.isArray(r.blindSpots),
    `patterns=${r?.patternCount} values=${r?.valueCount}`,
  );

  const cal = await analyzeCalibrationGaps();
  check(
    "[think] /calibrate backend computes per-domain coverage + gaps",
    !!cal && Array.isArray(cal.gaps) && typeof cal.overallCoverage === "number",
    `coverage=${cal?.overallCoverage} gaps=${cal?.gaps?.length}`,
  );
  const scenario = await getNextScenario();
  check(
    "[think] /calibrate returns a scenario (or null when covered)",
    scenario === null || (typeof scenario.id === "string" && typeof scenario.domain === "string"),
  );

  const dna = await compileDNA();
  check(
    "[think] /dna compiles a portable identity within a token budget",
    !!dna &&
      !!dna.dna &&
      typeof dna.stats?.estimatedTokens === "number" &&
      dna.stats.estimatedTokens > 0,
    `tokens~${dna?.stats?.estimatedTokens}`,
  );

  if (!KEEP) {
    await getKysely()
      .deleteFrom("user_model")
      .where("user_id", "=", owner)
      .where("key", "in", ["eval-think-ship", "eval-think-reliability", "eval-think-pnpm"])
      .execute();
  }
}

/**
 * Personality documents (DNA, shadow observations) + twin-test fidelity scores
 * live in the DB now (wiki pattern), not ~/.nomos files. Round-trip each store +
 * assert the jsonb content is a clean object (not double-encoded).
 */
async function runDocumentPersistence(): Promise<void> {
  const { upsertPersonalityDocument, getPersonalityDocument } =
    await import("../src/db/personality-documents.ts");
  const { loadExportedDNA } = await import("../src/memory/personality-dna.ts");
  const { recordFidelityScore, getFidelityHistory } = await import("../src/db/fidelity-scores.ts");
  const { calculateFidelityScore } = await import("../src/memory/twin-test.ts");
  const db = getKysely();
  const owner = resolveMemoryUserId(undefined);

  // DNA: the DB is the source of truth; loadExportedDNA reads it back.
  await upsertPersonalityDocument(owner, "dna", {
    version: "1.0",
    identity: { summary: "eval clone" },
    patterns: [],
    values: [],
  });
  const loaded = await loadExportedDNA();
  check(
    "[documents] personality DNA persists to + loads from the DB",
    !!loaded && typeof loaded === "object",
  );

  // Shadow observations round-trip.
  await upsertPersonalityDocument(owner, "shadow_observations", {
    tools: [{ name: "Bash" }],
    corrections: [],
    fileAccesses: [],
    turnTimestamps: [1],
  });
  const shadow = await getPersonalityDocument<{ tools: unknown[] }>(owner, "shadow_observations");
  check(
    "[documents] shadow observations round-trip via the DB",
    !!shadow && Array.isArray(shadow.tools) && shadow.tools.length === 1,
  );

  // jsonb content is a real object, not a double-encoded string.
  const res = await db.executeQuery(
    sql`SELECT count(*) FILTER (WHERE jsonb_typeof(content) NOT IN ('object','array')) AS bad, count(*) AS total FROM personality_documents`.compile(
      db,
    ),
  );
  const row = res.rows[0] as { bad: string; total: string };
  check(
    "[documents] personality_documents.content is a jsonb object (not double-encoded)",
    Number(row.bad) === 0 && Number(row.total) >= 1,
    `bad=${row.bad} total=${row.total}`,
  );

  // Twin-test fidelity: the documented formula + DB history.
  const score = calculateFidelityScore(
    [true, false, false].map((c) => ({ discriminatorCorrect: c }) as never),
  );
  check(
    "[documents] fidelity score = fraction fooled (formula)",
    Math.abs(score - 2 / 3) < 1e-9,
    `score=${score}`,
  );
  await recordFidelityScore({ userId: owner, score, pairs: 3, fooled: 2 });
  const hist = await getFidelityHistory(owner);
  check(
    "[documents] twin-test fidelity scores persist + read back as history",
    hist.length >= 1 && hist[0]!.pairs === 3 && hist[0]!.fooled === 2,
  );

  if (!KEEP) {
    await db.deleteFrom("personality_documents").where("user_id", "=", owner).execute();
    await db.deleteFrom("fidelity_scores").where("user_id", "=", owner).execute();
  }
}

/**
 * Heartbeat (auto-reply) instructions persist in the DB (config), not a
 * ~/.nomos/HEARTBEAT.md file. Round-trip setHeartbeat -> getHeartbeat through the DB.
 */
async function runHeartbeat(): Promise<void> {
  const { setHeartbeat, getHeartbeat } = await import("../src/auto-reply/heartbeat.ts");
  const content = "## Heartbeat\n- ping the team channel if a deploy is pending";
  await setHeartbeat(content);
  const back = await getHeartbeat();
  check(
    "[heartbeat] persists to + loads from the DB (not a file)",
    back === content,
    `len=${back?.length ?? 0}`,
  );
  if (!KEEP) {
    await getKysely().deleteFrom("config").where("key", "=", "heartbeat.content").execute();
  }
}

/**
 * Config store round-trips every jsonb scalar + object. Regression guard for the
 * postgres-js boolean hazard: a raw JS boolean infers as bool OID and Postgres
 * refuses the implicit bool->jsonb cast, so setConfigValue must serialize + cast.
 */
async function runConfigScalars(): Promise<void> {
  const { setConfigValue, getConfigValue, deleteConfigValue } = await import("../src/db/config.ts");
  const cases: Array<[string, unknown]> = [
    ["app.__eval_bool_false__", false],
    ["app.__eval_bool_true__", true],
    ["app.__eval_num__", 20],
    ["app.__eval_str__", "1h"],
    ["app.__eval_obj__", { a: 1, b: "x" }],
  ];
  const mismatches: string[] = [];
  for (const [k, v] of cases) {
    await setConfigValue(k, v);
    const back = await getConfigValue(k);
    if (JSON.stringify(back) !== JSON.stringify(v)) {
      mismatches.push(`${k}: wrote ${JSON.stringify(v)} read ${JSON.stringify(back)}`);
    }
    if (!KEEP) await deleteConfigValue(k);
  }
  check(
    "[config] bool/number/string/object values round-trip through jsonb",
    mismatches.length === 0,
    mismatches.join("; "),
  );
}

/**
 * Autonomous loops: bundled LOOP.md files seed into cron_jobs (disabled), and the
 * agent can author its own owner-scoped loops (source='agent') via the loop tools.
 */
async function runAutonomousLoops(): Promise<void> {
  const { seedAutonomousLoops } = await import("../src/daemon/autonomous.ts");
  const { CronStore } = await import("../src/cron/store.ts");
  await seedAutonomousLoops();
  const store = new CronStore();

  const bundled = await store.listJobs({ source: "bundled" });
  const names = new Set(bundled.map((j) => j.name));
  check(
    "[loops] bundled LOOP.md definitions are seeded into cron_jobs",
    ["calendar-prep", "email-triage", "memory-consolidation", "slack-digest"].every((n) =>
      names.has(n),
    ),
    `bundled=${bundled.length}: ${[...names].slice(0, 8).join(", ")}`,
  );
  check(
    "[loops] bundled loops are seeded disabled (opt-in, never auto-fire)",
    bundled.length > 0 && bundled.every((j) => j.enabled === false),
  );

  // Agent self-authoring: a loop created in-loop is owner-scoped + source='agent'.
  const owner = "eval-loops-user";
  const id = await store.createJob({
    userId: owner,
    name: "__eval_agent_loop__",
    schedule: "0 9 * * 1",
    scheduleType: "cron",
    sessionTarget: "isolated",
    deliveryMode: "none",
    prompt: "review then AUTONOMOUS_OK",
    enabled: true,
    errorCount: 0,
    source: "agent",
  });
  const mine = await store.listJobs({ userId: owner, source: "agent" });
  check(
    "[loops] agent-created loop is owner-scoped + tagged source=agent",
    mine.length === 1 && mine[0]?.name === "__eval_agent_loop__" && mine[0]?.source === "agent",
    `mine=${mine.length}`,
  );
  check(
    "[loops] agent loop is invisible to other owners (per-user isolation)",
    (await store.listJobs({ userId: "eval-other-user" })).every(
      (j) => j.name !== "__eval_agent_loop__",
    ),
  );
  if (!KEEP) await store.deleteJob(id);
}

async function runEval(): Promise<void> {
  await runMode("power_user");
  await runMode("hosted");
  await runWire();
  await runHostedWire();
  await runGoogleAuth();

  // Derived stores built from the vault (deterministic, no LLM): the knowledge
  // graph, auto-dream consolidation, and the wiki, each with per-user isolation.
  await runGraphBuild();
  await runConsolidation();
  await runAutoDreamState();
  await runWikiArticles();
  await runCommitments();
  await runSessionResume();
  await runCron();
  await runTasks();
  await runDrafts();
  await runAutoLinkerGuard();
  await runRelationshipStats();
  await runManagedFiles();
  await runStyleProfiles();
  await runStudioLearn();
  await runMoodLog();
  await runRelationshipNarrative();
  await runGraphMetadata();
  await runBacklinks();
  await runMetadataColumns();
  await runMagicDocState();
  await runAutoDreamDeep();
  await runQuickFixWiring();
  await runGetMessagesWire();
  await runConversationEmbedding();
  await runToolApprovalGate();
  await runThinkTools();
  await runDocumentPersistence();
  await runHeartbeat();
  await runConfigScalars();
  await runAutonomousLoops();

  // Negative control: a judge that passes everything is worthless. Prove it
  // rejects a response that plainly misses the rubric.
  if (hasLLM) {
    const neg = await judge({
      context: "The user asked their assistant: who is my dentist?",
      response: "Your favorite color is blue.",
      rubric: "A passing response must contain the dentist's name (Dr. Patel).",
    });
    check("[judge] rejects a response that misses the rubric", !neg.pass, neg.reasoning);
  } else {
    skip("[judge] rejects a response that misses the rubric", "no LLM provider configured");
  }

  // Slowest last: live agent conversations. NomosAgent.Chat over gRPC (unauth,
  // power-user), then the JWT-gated MobileApi.Chat with a real nomos-server token.
  await runGrpcChat();
  await runHostedMobileChat();
}

void main();
