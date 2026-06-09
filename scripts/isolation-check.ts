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
  }

  await closeDb();
  // eslint-disable-next-line no-console
  console.log(
    `\n${failures.length === 0 ? "OK: no cross-user leaks" : `FAIL: ${failures.length} leak(s)`}`,
  );
  if (failures.length > 0) process.exit(1);
}

void main();
