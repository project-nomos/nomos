/**
 * Per-user isolation check.
 *
 * Writes memory under two users (A and B) THROUGH THE REAL APPLICATION FUNCTIONS
 * (not raw SQL), then reads back as each user and asserts that neither ever sees
 * the other's data. This is the end-to-end proof that the per-user scoping holds
 * at the application layer, across every store: vault, memory_chunks, user_model,
 * contacts, contact_identities, wiki_articles.
 *
 * Run:  DATABASE_URL=... pnpm tsx scripts/isolation-check.ts
 * Exits non-zero on any cross-user leak.
 */

import { closeDb, getKysely } from "../src/db/client.ts";
import { vaultWrite, vaultRead, vaultSearch, vaultDelete } from "../src/memory/vault.ts";
import { storeMemoryChunk, searchMemoryByText, deleteMemoryBySource } from "../src/db/memory.ts";
import { upsertUserModel, getUserModel, deleteUserModelEntry } from "../src/db/user-model.ts";
import {
  createContact,
  listContacts,
  searchContacts,
  mergeContacts,
  deleteContact,
} from "../src/identity/contacts.ts";
import { upsertArticle, searchArticles, listArticles, deleteArticle } from "../src/db/wiki.ts";
import { upsertNode, upsertEdge, invalidateEdge } from "../src/memory/graph.ts";
import { getSupersededFacts } from "../src/memory/graph-contradictions.ts";
import type { TenantContext } from "../src/auth/tenant-context.ts";
import { appendEdit, createAsset, getAsset, listEdits } from "../src/studio/assets.ts";
import { validateOp } from "../src/studio/ops.ts";

const A = "iso-user-a";
const B = "iso-user-b";

const failures: string[] = [];
function check(label: string, cond: boolean) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`PASS  ${label}`);
  } else {
    failures.push(label);
    // eslint-disable-next-line no-console
    console.log(`FAIL  ${label}`);
  }
}

async function main(): Promise<void> {
  // ── Seed identical-looking data under both users, via the real write paths ──
  await vaultWrite(A, "secret.md", "Project APOLLO launch is March, owner alice");
  await vaultWrite(B, "secret.md", "Project ZEUS launch is May, owner bob");

  await storeMemoryChunk({
    id: `iso:${A}:1`,
    userId: A,
    source: "conversation",
    text: "alice loves vim",
  });
  await storeMemoryChunk({
    id: `iso:${B}:1`,
    userId: B,
    source: "conversation",
    text: "bob loves emacs",
  });

  await upsertUserModel({
    userId: A,
    category: "preference",
    key: "editor",
    value: "vim",
    sourceIds: [],
    confidence: 0.9,
  });
  await upsertUserModel({
    userId: B,
    category: "preference",
    key: "editor",
    value: "emacs",
    sourceIds: [],
    confidence: 0.9,
  });

  const ca = await createContact(A, { displayName: "Shared Sam" });
  const cb = await createContact(B, { displayName: "Shared Sam" });

  await upsertArticle(A, "contacts/sam.md", "Sam", "alice notes on Sam", "contacts");
  await upsertArticle(B, "contacts/sam.md", "Sam", "bob notes on Sam", "contacts");

  // Wiki lint report (category 'lint') — same store, must stay owner-scoped.
  await upsertArticle(A, "_lint.md", "Wiki Lint Report", "alice orphan APOLLO", "lint");
  await upsertArticle(B, "_lint.md", "Wiki Lint Report", "bob orphan ZEUS", "lint");

  // Superseded facts (kg_edges.invalid_at) — getSupersededFacts is the new query
  // the compiler + linter rely on; prove it is user-scoped. Seed one invalidated
  // works_at edge for each user with the SAME subject name but distinct employers.
  const tgA: TenantContext = { orgId: "local", userId: A };
  const tgB: TenantContext = { orgId: "local", userId: B };
  const subjA = await upsertNode(tgA, { kind: "person", name: "Shared Subject", confidence: 0.9 });
  const subjB = await upsertNode(tgB, { kind: "person", name: "Shared Subject", confidence: 0.9 });
  const oldA = await upsertNode(tgA, { kind: "org", name: "ACME-ALICE", confidence: 0.8 });
  const oldB = await upsertNode(tgB, { kind: "org", name: "ZEUS-BOB", confidence: 0.8 });
  const eA = await upsertEdge(tgA, {
    srcId: subjA,
    dstId: oldA,
    relType: "works_at",
    fact: "Shared Subject worked at ACME-ALICE",
    confidence: 0.9,
  });
  const eB = await upsertEdge(tgB, {
    srcId: subjB,
    dstId: oldB,
    relType: "works_at",
    fact: "Shared Subject worked at ZEUS-BOB",
    confidence: 0.9,
  });
  await invalidateEdge(tgA, eA, new Date());
  await invalidateEdge(tgB, eB, new Date());

  // ── Vault ──
  check(
    "vault: A reads its own note",
    (await vaultRead(A, "secret.md"))?.content.includes("APOLLO") === true,
  );
  check(
    "vault: A's read never returns B's note",
    (await vaultRead(A, "secret.md"))?.content.includes("ZEUS") === false,
  );
  check(
    "vault: A search excludes B",
    (await vaultSearch(A, "launch")).every((n) => !n.content.includes("ZEUS")),
  );
  check(
    "vault: B search excludes A",
    (await vaultSearch(B, "launch")).every((n) => !n.content.includes("APOLLO")),
  );

  // ── memory_chunks ──
  check(
    "chunks: A FTS excludes B",
    (await searchMemoryByText(A, "loves")).every((r) => !r.text.includes("emacs")),
  );
  check(
    "chunks: B FTS excludes A",
    (await searchMemoryByText(B, "loves")).every((r) => !r.text.includes("vim")),
  );

  // ── user_model ──
  const amodel = await getUserModel(A, "preference");
  check("user_model: A sees exactly one preference row", amodel.length === 1);
  check(
    "user_model: A's model never contains B's value",
    !JSON.stringify(amodel).includes("emacs"),
  );
  const bmodel = await getUserModel(B, "preference");
  check("user_model: B sees exactly one preference row", bmodel.length === 1);
  check("user_model: B's model never contains A's value", !JSON.stringify(bmodel).includes("vim"));

  // ── contacts ──
  check(
    "contacts: A lists only its own",
    (await listContacts(A)).every((c) => c.user_id === A),
  );
  check(
    "contacts: A search excludes B",
    (await searchContacts(A, "Shared")).every((c) => c.user_id === A),
  );
  // cross-user merge must be a no-op (cannot merge B's contact into A's space)
  await mergeContacts(A, ca.id, cb.id);
  check(
    "contacts: cross-user merge did NOT delete B's contact",
    (await listContacts(B)).some((c) => c.id === cb.id),
  );

  // ── wiki_articles ──
  check(
    "wiki: A search excludes B",
    (await searchArticles(A, "notes")).every((a) => a.user_id === A),
  );
  check(
    "wiki: A lists only its own",
    (await listArticles(A)).every((a) => a.user_id === A),
  );
  check(
    "wiki-lint: A's _lint.md report never leaks B's content",
    !JSON.stringify(await listArticles(A)).includes("ZEUS") &&
      (await searchArticles(A, "orphan")).every((a) => a.user_id === A),
  );

  // ── superseded facts (kg_edges) via getSupersededFacts ──
  const supA = await getSupersededFacts(A, "Shared Subject");
  const supB = await getSupersededFacts(B, "Shared Subject");
  check(
    "superseded: A sees its own superseded fact",
    supA.some((s) => s.fact.includes("ACME-ALICE")),
  );
  check(
    "superseded: A's superseded facts never contain B's",
    supA.every((s) => !s.fact.includes("ZEUS-BOB")),
  );
  check(
    "superseded: B's superseded facts never contain A's",
    supB.every((s) => !s.fact.includes("ACME-ALICE")),
  );

  // ── studio (assets + edits) ──
  const tA: TenantContext = { orgId: "local", userId: A };
  const tB: TenantContext = { orgId: "local", userId: B };
  const saA = await createAsset(tA, {
    objectKey: "org/local/studio/isoA/original.jpg",
    contentHash: "ha",
    mime: "image/jpeg",
  });
  const saB = await createAsset(tB, {
    objectKey: "org/local/studio/isoB/original.jpg",
    contentHash: "hb",
    mime: "image/jpeg",
  });
  const { edit: eaA } = await appendEdit(tA, {
    assetId: saA.id,
    parentEditId: null,
    idempotencyKey: "iso-ka",
    op: validateOp({ op: "adjust", params: { exposure: 0.2 } }),
  });
  const { edit: eaB } = await appendEdit(tB, {
    assetId: saB.id,
    parentEditId: null,
    idempotencyKey: "iso-kb",
    op: validateOp({ op: "adjust", params: { exposure: 0.2 } }),
  });
  check("studio: A cannot read B's asset", (await getAsset(tA, saB.id)) === null);
  check("studio: B cannot read A's asset", (await getAsset(tB, saA.id)) === null);
  check("studio: A reads its own asset", (await getAsset(tA, saA.id))?.id === saA.id);
  check("studio: A history excludes B's edits", (await listEdits(tA, saB.id)).length === 0);
  check(
    "studio: A history has its own edit",
    (await listEdits(tA, saA.id)).some((e) => e.id === eaA.id),
  );
  check(
    "studio: B history has its own edit",
    (await listEdits(tB, saB.id)).some((e) => e.id === eaB.id),
  );

  // ── Cleanup ──
  await vaultDelete(A, "secret.md");
  await vaultDelete(B, "secret.md");
  await deleteMemoryBySource(A, "conversation");
  await deleteMemoryBySource(B, "conversation");
  await deleteUserModelEntry(A, "preference", "editor");
  await deleteUserModelEntry(B, "preference", "editor");
  await deleteContact(A, ca.id);
  await deleteContact(B, cb.id);
  await deleteArticle(A, "contacts/sam.md");
  await deleteArticle(B, "contacts/sam.md");
  // sweep any stray rows from this run
  const db = getKysely();
  for (const uid of [A, B]) {
    await db.deleteFrom("memory_chunks").where("user_id", "=", uid).execute();
    await db.deleteFrom("vault_notes").where("user_id", "=", uid).execute();
    await db.deleteFrom("user_model").where("user_id", "=", uid).execute();
    await db.deleteFrom("contacts").where("user_id", "=", uid).execute();
    await db.deleteFrom("wiki_articles").where("user_id", "=", uid).execute();
    await db.deleteFrom("kg_edges").where("user_id", "=", uid).execute();
    await db.deleteFrom("kg_nodes").where("user_id", "=", uid).execute();
    await db.deleteFrom("studio_edits").where("user_id", "=", uid).execute();
    await db.deleteFrom("studio_assets").where("user_id", "=", uid).execute();
  }

  await closeDb();
  // eslint-disable-next-line no-console
  console.log(
    `\n${failures.length === 0 ? "OK: no cross-user leaks" : `FAIL: ${failures.length} leak(s)`}`,
  );
  if (failures.length > 0) process.exit(1);
}

void main();
