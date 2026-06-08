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
 * Run:  DATABASE_URL=... [NOMOS_USE_SUBSCRIPTION=true] pnpm eval:agent
 * Exits non-zero on any failure. Judge + real-token checks skip (reported) when no
 * LLM provider / no nomos-server is available.
 */

import { homedir } from "node:os";
import { join } from "node:path";
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
import { storeMemoryChunk, searchMemoryByText, deleteMemoryByPath } from "../src/db/memory.ts";
import { createContact, listContacts } from "../src/identity/contacts.ts";
import { createSession, getSessionByKey } from "../src/db/sessions.ts";
import { countTranscriptMessages, appendTranscriptMessage } from "../src/db/transcripts.ts";
import {
  backfillGraph,
  getProjection,
  neighborhood,
  getNodeByExternal,
} from "../src/memory/graph.ts";
import { consolidateMemory } from "../src/memory/consolidator.ts";
import { autoDream, getConsolidationState } from "../src/memory/auto-dream.ts";
import { storeCommitments, getPendingCommitments } from "../src/proactive/commitment-tracker.ts";
import { compileKnowledge } from "../src/memory/knowledge-compiler.ts";
import { listArticles, upsertArticle, searchArticles } from "../src/db/wiki.ts";
import { isEphemeralSession } from "../src/daemon/memory-indexer.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";
import type { AgentEvent } from "../src/daemon/types.ts";
import { refreshJwks } from "../src/auth/jwt-validator.ts";
import { judge } from "./judge.ts";
import { startWire, startConnectServer, makeMobileClient } from "./wire.ts";
import { startHostedAuth } from "./hosted-auth.ts";
import { provisionRealUser } from "./nomos-server-auth.ts";

// The judge needs any provider the forked-agent path supports: a direct API key,
// Vertex, or a Claude subscription (NOMOS_USE_SUBSCRIPTION).
const hasLLM =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
  process.env.NOMOS_USE_SUBSCRIPTION === "true";

// `--keep` leaves the throwaway DB AND skips the per-test data cleanup, so the
// rows each check wrote remain in nomos_eval for inspection. Server/connection
// teardown still runs unconditionally.
const KEEP = process.argv.slice(2).includes("--keep");

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
  const server = await startConnectServer(8798);
  const alice = makeMobileClient(8798, () => auth.mint("eval-alice"));
  const bob = makeMobileClient(8798, () => auth.mint("eval-bob"));
  const anon = makeMobileClient(8798); // no bearer
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
    server = await startConnectServer(8797, queue);
    const client = makeMobileClient(8797, () => real.token);

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
  // The dormant autoDream() orchestrator persists a singleton run-state row
  // (instance-wide). Gates: turn delta >= 10, time gate skipped on fresh state;
  // the Redis lease no-ops without REDIS_URL. Asserts the state IS written + that
  // the gate then blocks a premature re-run.
  await getKysely().deleteFrom("auto_dream_state").execute();
  const noop = async () => ({ merged: 0, pruned: 0, newChunks: 0, durationMs: 0 });

  const ran = await autoDream(10, noop);
  check("[auto-dream-state] autoDream runs when the turn gate is met", ran !== null);
  const state = await getConsolidationState();
  check(
    "[auto-dream-state] run-state is persisted (last_run_at + turn count + total_runs)",
    Boolean(state.lastRunAt) && state.lastTurnCount === 10 && state.totalRuns === 1,
  );
  const blocked = await autoDream(10, noop);
  check("[auto-dream-state] gate blocks a re-run without 10 new turns", blocked === null);
}

async function runGetMessagesWire(): Promise<void> {
  // MobileApi.GetMessages over the authenticated Connect wire: multi-session AND
  // per-user isolation. Deterministic (no LLM): seeds owned sessions + transcripts
  // directly, then reads them back over the wire as each tenant.
  const auth = await startHostedAuth("eval-org");
  const ids = ["eval-alice", "eval-bob"];
  await seedOrgMembers(ids);
  const server = await startConnectServer(8798);
  const alice = makeMobileClient(8798, () => auth.mint("eval-alice"));
  const bob = makeMobileClient(8798, () => auth.mint("eval-bob"));
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
      await makeMobileClient(8798).getMessages({ sessionKey: aKey1, limit: 50 });
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
    "[commitments] B does not see A's commitments",
    (await getPendingCommitments(B)).every(
      (c) => c.user_id === B && c.description !== "send the quarterly report",
    ),
  );
}

async function runWikiArticles(): Promise<void> {
  // Derived store: wiki_articles. Deterministic write + per-user isolation by
  // default; the full LLM compile (2 Sonnet passes, writes ~/.nomos/wiki) is
  // opt-in via EVAL_WIKI_COMPILE=1.
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

  if (process.env.EVAL_WIKI_COMPILE === "1" && hasLLM) {
    await vaultWrite(
      A,
      "people/dana.md",
      "Dana Smith is the VP of Engineering at Acme, leads the platform team, and prefers async standups.",
      { title: "Dana Smith" },
    );
    const res = await compileKnowledge({ userId: A, force: true });
    check(
      "[wiki] LLM compile produces articles from the vault",
      res.articlesCreated + res.articlesUpdated > 0,
      res.errors.join("; ") || undefined,
    );
    check(
      "[wiki] compiled articles are owner-scoped",
      (await listArticles(A)).every((a) => a.user_id === A),
    );
  } else {
    skip(
      "[wiki] LLM compile produces articles from the vault",
      "set EVAL_WIKI_COMPILE=1 (makes Sonnet calls + writes ~/.nomos/wiki)",
    );
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // `--clean`: just drop a previously kept test DB and exit (tidy up after --keep).
  if (args.includes("--clean")) {
    await dropTestDb(process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos");
    return;
  }
  // `--keep`: run normally but leave the test DB (and everything the run wrote) intact
  // so it can be inspected; drop it later with `pnpm eval:agent --clean`.
  const keep = args.includes("--keep");

  // eslint-disable-next-line no-console
  console.log(`Agent eval (LLM judge: ${hasLLM ? "on" : "off"}${keep ? "; --keep" : ""})\n`);
  const { baseUrl } = await setupTestDb();
  try {
    await runEval();
  } finally {
    if (keep) {
      await closeDb(); // release the pool so the process can exit; do NOT drop the DB
      // eslint-disable-next-line no-console
      console.log(
        `\nKept test DB for inspection:\n  psql "${process.env.DATABASE_URL}"\n  drop it with: pnpm eval:agent --clean`,
      );
    } else {
      // The throwaway DB is dropped wholesale, so per-row cleanup is belt-and-braces.
      await finalSweep().catch(() => undefined);
      await teardownTestDb(baseUrl);
    }
  }

  const failed = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skipped);
  // eslint-disable-next-line no-console
  console.log(
    `\n${failed.length === 0 ? "OK" : "FAIL"}: ${results.length - skipped.length} ran, ` +
      `${failed.length} failed, ${skipped.length} skipped`,
  );
  if (failed.length > 0) process.exit(1);
}

async function runEval(): Promise<void> {
  await runMode("power_user");
  await runMode("hosted");
  await runWire();
  await runHostedWire();

  // Derived stores built from the vault (deterministic, no LLM): the knowledge
  // graph, auto-dream consolidation, and the wiki, each with per-user isolation.
  await runGraphBuild();
  await runConsolidation();
  await runAutoDreamState();
  await runWikiArticles();
  await runCommitments();
  await runGetMessagesWire();

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
