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
 *  - the real mobile endpoints over the Connect wire (write/list/get/delete vault)
 *
 * Run:  DATABASE_URL=... [ANTHROPIC_API_KEY=...] pnpm eval:agent
 * Exits non-zero on any failure. The judge checks are skipped (reported) when no
 * LLM provider is configured.
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

import { sql } from "kysely";
import { ConnectError, Code } from "@connectrpc/connect";
import { closeDb, getKysely } from "../src/db/client.ts";
import { resolveMemoryUserId } from "../src/auth/tenant-context.ts";
import { vaultWrite, vaultSearch, vaultRead, vaultDelete } from "../src/memory/vault.ts";
import { storeMemoryChunk, searchMemoryByText, deleteMemoryByPath } from "../src/db/memory.ts";
import { createContact, listContacts } from "../src/identity/contacts.ts";
import { createSession, getSessionByKey } from "../src/db/sessions.ts";
import { isEphemeralSession } from "../src/daemon/memory-indexer.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";
import type { AgentEvent } from "../src/daemon/types.ts";
import { judge } from "./judge.ts";
import { startWire, startConnectServer, makeMobileClient } from "./wire.ts";
import { startHostedAuth } from "./hosted-auth.ts";

// The judge needs any provider the forked-agent path supports: a direct API key,
// Vertex, or a Claude subscription (NOMOS_USE_SUBSCRIPTION).
const hasLLM =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
  process.env.NOMOS_USE_SUBSCRIPTION === "true";

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
  // the synthetic hosted tenants, which never hold real data) ──
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
    // bulk delete of the real local owner.
    await purgeArtifacts("local", { notePath });
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
    await removeOrgMembers(ids);
    for (const id of ids) await purgeSyntheticTenant(id);
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
    await getKysely()
      .deleteFrom("sessions")
      .where("session_key", "=", dbSessionKey)
      .execute()
      .catch(() => undefined);
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

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Agent eval (LLM judge: ${hasLLM ? "on" : "off"})\n`);
  await runMode("power_user");
  await runMode("hosted");
  await runWire();
  await runHostedWire();

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

  // Slowest last: a live agent conversation over the gRPC Chat wire.
  await runGrpcChat();

  // Settle-and-sweep any fire-and-forget vault index writes that outraced cleanup.
  await finalSweep();

  const failed = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skipped);
  // eslint-disable-next-line no-console
  console.log(
    `\n${failed.length === 0 ? "OK" : "FAIL"}: ${results.length - skipped.length} ran, ` +
      `${failed.length} failed, ${skipped.length} skipped`,
  );
  await closeDb();
  if (failed.length > 0) process.exit(1);
}

void main();
