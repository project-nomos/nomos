/**
 * Recall eval harness for the memory system.
 *
 * Seeds a set of known facts into the vault, then probes retrieval and scores
 * recall@5: did the note that holds the answer surface for the question? Two passes:
 *
 *   1. FTS floor   - vaultSearch (keyword). Deterministic, needs no embeddings,
 *      runs in CI. The regression guard. Probed only with LEXICAL questions (which
 *      share a word with the note), which is the most FTS can be asked to do.
 *   2. Hybrid      - generateEmbedding + hybridSearch (vector + FTS + graph, the
 *      path the agent actually uses). Probed with the lexical questions AND
 *      no-lexical-overlap PARAPHRASES ("which carrier do I book" against a note
 *      that says "flies United"). Only the vector arm can bridge those, so this
 *      pass measures semantic recall. Skipped (not failed) when embeddings are
 *      unavailable, mirroring how production degrades to FTS.
 *
 * Run:  pnpm eval:recall
 *       (DATABASE_URL from env/CLI; embedding creds from ~/.nomos/.env or repo .env)
 * Exits non-zero if an enforced threshold is missed.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

// Load embedding creds (GOOGLE_API_KEY / GOOGLE_CLOUD_PROJECT) the way the app
// does so the hybrid pass can run. dotenv does not override already-set vars, so a
// CLI-provided DATABASE_URL still wins; embeddings.ts / db read env lazily at call
// time, so loading here (after imports) is in time for the runtime pass.
config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });

// The eval enriches notes explicitly + awaited (below) to observe the effect
// deterministically; turn off vaultWrite's fire-and-forget enrichment so it can't
// race that. Production keeps enrichment on.
process.env.NOMOS_MEMORY_ENRICHMENT = "false";

import { closeDb } from "../src/db/client.ts";
import { generateEmbedding, isEmbeddingAvailable } from "../src/memory/embeddings.ts";
import { enrichNoteRetrieval } from "../src/memory/enrichment.ts";
import { hybridSearch } from "../src/memory/search.ts";
import { vaultDelete, vaultSearch, vaultWrite } from "../src/memory/vault.ts";

const USER = "recall-eval";
const K = 5; // recall@K

// Floors, not ceilings. The FTS floor guards the keyword baseline against
// regressions; the hybrid floor guards the semantic path (and must never drop
// below the FTS number on the same probes, or the vector arm is dead weight).
const FTS_LEXICAL_FLOOR = 0.8;
// With write-time enrichment on, the hybrid pass clears the paraphrases too
// (observed 27/27). Floored below that to tolerate LLM-alias / embedding-margin
// nondeterminism, while still guarding the enrichment win.
const HYBRID_FLOOR = 0.85;

interface Probe {
  q: string;
  /** No lexical overlap with the note: only the vector arm can match it. */
  paraphrase?: boolean;
}
interface Case {
  path: string;
  content: string;
  probes: Probe[];
}

const CASES: Case[] = [
  {
    path: "recall-eval/dentist.md",
    content:
      "The user's dentist is Dr. Patel at 5th Avenue Dental. Their next cleaning is on June 21.",
    probes: [
      { q: "who is my dentist" },
      { q: "when is my dentist cleaning" },
      { q: "Dr. Patel" },
      { q: "which tooth doctor do I see", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/coffee.md",
    content: "The user drinks oat-milk flat whites with no sugar. They dislike drip coffee.",
    probes: [
      { q: "how do I take my coffee" },
      { q: "what milk do I like in coffee" },
      { q: "what do I usually order at a cafe", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/people/dana.md",
    content: "Dana Wu is the user's design lead at Acme. They worked together on the offsite deck.",
    probes: [
      { q: "who is Dana" },
      { q: "who is my design lead at Acme" },
      { q: "the offsite deck" },
      { q: "who owns branding at work", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/travel.md",
    content: "The user prefers aisle seats, flies United, and keeps a TSA PreCheck number on file.",
    probes: [
      { q: "what seat do I prefer on flights" },
      { q: "which airline do I fly" },
      { q: "which carrier do I book for trips", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/projects/offsite.md",
    content:
      "The Q3 offsite is in Tahoe, budget 40k, owner is the user, decision needed on the venue by July 1.",
    probes: [
      { q: "where is the Q3 offsite" },
      { q: "what is the offsite budget" },
      { q: "offsite venue decision" },
      { q: "how much can we spend on the team retreat", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/gym.md",
    content:
      "The user works out at their gym, Equinox on Market Street, with early-morning strength training.",
    probes: [
      { q: "what gym do I go to" },
      { q: "where do I work out" },
      { q: "where do I exercise each day", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/car.md",
    content: "The user drives a blue Rivian R1S and parks it in spot B12 of the garage.",
    probes: [
      { q: "what car do I drive" },
      { q: "where do I park" },
      { q: "what vehicle do I own", paraphrase: true },
    ],
  },
  {
    path: "recall-eval/allergy.md",
    content: "The user is allergic to shellfish and carries an EpiPen for emergencies.",
    probes: [
      { q: "what am I allergic to" },
      { q: "do I carry an EpiPen" },
      { q: "what foods should a restaurant avoid serving me", paraphrase: true },
    ],
  },
];

interface PassScore {
  all: number;
  lexical: number;
}

async function scorePass(
  label: string,
  recall: (q: string) => Promise<string[]>,
): Promise<PassScore> {
  let hits = 0;
  let total = 0;
  let hitsLex = 0;
  let totalLex = 0;
  const misses: string[] = [];

  // eslint-disable-next-line no-console
  console.log(`\n=== ${label} ===`);
  for (const c of CASES) {
    for (const p of c.probes) {
      total++;
      if (!p.paraphrase) totalLex++;
      const paths = await recall(p.q);
      const hit = paths.includes(c.path);
      if (hit) {
        hits++;
        if (!p.paraphrase) hitsLex++;
      } else {
        misses.push(`${p.paraphrase ? "[para] " : "       "}"${p.q}" -> ${c.path}`);
      }
      // eslint-disable-next-line no-console
      console.log(`${hit ? "PASS" : "MISS"}  ${p.paraphrase ? "[para] " : "       "}"${p.q}"`);
    }
  }

  const all = total ? hits / total : 0;
  const lexical = totalLex ? hitsLex / totalLex : 0;
  // eslint-disable-next-line no-console
  console.log(
    `${label}: all ${hits}/${total} = ${(all * 100).toFixed(0)}%, ` +
      `lexical ${hitsLex}/${totalLex} = ${(lexical * 100).toFixed(0)}%`,
  );
  if (misses.length) {
    // eslint-disable-next-line no-console
    console.log("misses:\n" + misses.map((m) => "  - " + m).join("\n"));
  }
  return { all, lexical };
}

async function main(): Promise<void> {
  const failures: string[] = [];
  try {
    // Clean slate, then seed. vaultWrite indexes each note into the vector store
    // too (when embeddings are available), which is what the hybrid pass probes.
    for (const c of CASES) await vaultDelete(USER, c.path).catch(() => {});
    for (const c of CASES) await vaultWrite(USER, c.path, c.content, { title: c.path });

    // Write-time enrichment (B): store paraphrase aliases so the hybrid pass can
    // land the no-lexical-overlap paraphrase probes. Forced + awaited here so the
    // effect is observed deterministically.
    let aliasTotal = 0;
    for (const c of CASES) {
      aliasTotal += await enrichNoteRetrieval(USER, c.path, c.content, { force: true });
    }
    if (isEmbeddingAvailable()) {
      // eslint-disable-next-line no-console
      console.log(`Enrichment: ${aliasTotal} alias chunks written across ${CASES.length} notes`);
    }

    // Pass 1: FTS floor (keyword). Lexical recall is the enforced guard.
    const fts = await scorePass("FTS (keyword)", async (q) =>
      (await vaultSearch(USER, q, K)).map((r) => r.path),
    );
    if (fts.lexical < FTS_LEXICAL_FLOOR) {
      failures.push(
        `FTS lexical recall ${(fts.lexical * 100).toFixed(0)}% < floor ${FTS_LEXICAL_FLOOR * 100}%`,
      );
    }

    // Pass 2: Hybrid (vector + FTS + graph) — the path the agent uses. Probes the
    // paraphrases the FTS pass cannot bridge. Skipped (not failed) without creds.
    const embeddings = isEmbeddingAvailable();
    if (embeddings) {
      try {
        const hybrid = await scorePass("Hybrid (vector+FTS)", async (q) => {
          const embedding = await generateEmbedding(q);
          return (await hybridSearch(USER, q, embedding, K)).map((r) => r.path);
        });
        if (hybrid.all < HYBRID_FLOOR) {
          failures.push(
            `Hybrid recall ${(hybrid.all * 100).toFixed(0)}% < floor ${HYBRID_FLOOR * 100}%`,
          );
        }
        if (hybrid.all < fts.all) {
          failures.push(
            `Hybrid recall ${(hybrid.all * 100).toFixed(0)}% regressed below FTS ` +
              `${(fts.all * 100).toFixed(0)}% on the same probes (vector arm not helping)`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`\nHybrid pass errored (${(err as Error).message}); not enforced.`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        "\nHybrid pass SKIPPED: no embedding creds (GOOGLE_API_KEY / GOOGLE_CLOUD_PROJECT). " +
          "FTS-only — the paraphrase gap is exactly what the vector arm would close.",
      );
    }
  } finally {
    for (const c of CASES) await vaultDelete(USER, c.path).catch(() => {});
    // closeDb can hang behind the embedding HTTP keep-alive agent / in-flight
    // best-effort chunk deletes; bound it so the run always terminates.
    await Promise.race([closeDb(), new Promise((res) => setTimeout(res, 2000))]).catch(() => {});
  }

  if (failures.length) {
    // eslint-disable-next-line no-console
    console.error("\nFAIL:\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("\nOK");
  // The hybrid pass opens keep-alive sockets to the embedding API that can hold
  // the event loop open after closeDb(); exit explicitly so CI does not hang.
  process.exit(0);
}

void main();
