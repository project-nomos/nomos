/**
 * Recall eval harness for the memory system.
 *
 * Seeds a set of known facts into the vault, then probes retrieval with natural
 * phrasings and scores recall@k: did the note that holds the answer surface for
 * the question? This is the plumbing-level eval (does what we stored come back),
 * runnable in CI against a test DB, and the guardrail prior art warned about:
 * catch silent recall regressions as the memory system evolves.
 *
 * A fuller LLM-answer eval (does the agent ANSWER correctly) is a follow-up that
 * runs the model; this one is cheap and deterministic.
 *
 * Run:  DATABASE_URL=... pnpm tsx scripts/recall-eval.ts
 * Exits non-zero if recall drops below the threshold.
 */

import { closeDb } from "../src/db/client.ts";
import { vaultDelete, vaultSearch, vaultWrite } from "../src/memory/vault.ts";

const USER = "recall-eval";
// This probes vaultSearch (FTS), the deterministic baseline that runs without
// embeddings, so it is a regression guard, not the ceiling. In production the
// agent recalls via the hybrid memory_search (vector + FTS) over vault notes
// that vaultWrite now indexes into the vector store, which scores higher.
const THRESHOLD = 0.6; // recall@5 floor for the FTS baseline

interface Case {
  path: string;
  content: string;
  probes: string[];
}

const CASES: Case[] = [
  {
    path: "recall-eval/dentist.md",
    content:
      "The user's dentist is Dr. Patel at 5th Avenue Dental. Their next cleaning is on June 21.",
    probes: ["who is my dentist", "when is my dentist cleaning", "Dr. Patel"],
  },
  {
    path: "recall-eval/coffee.md",
    content: "The user drinks oat-milk flat whites with no sugar. They dislike drip coffee.",
    probes: ["how do I take my coffee", "what milk do I like in coffee"],
  },
  {
    path: "recall-eval/people/dana.md",
    content: "Dana Wu is the user's design lead at Acme. They worked together on the offsite deck.",
    probes: ["who is Dana", "who is my design lead at Acme", "the offsite deck"],
  },
  {
    path: "recall-eval/travel.md",
    content: "The user prefers aisle seats, flies United, and keeps a TSA PreCheck number on file.",
    probes: ["what seat do I prefer on flights", "which airline do I fly"],
  },
  {
    path: "recall-eval/projects/offsite.md",
    content:
      "The Q3 offsite is in Tahoe, budget 40k, owner is the user, decision needed on the venue by July 1.",
    probes: ["where is the Q3 offsite", "what is the offsite budget", "offsite venue decision"],
  },
];

async function main(): Promise<void> {
  for (const c of CASES) await vaultWrite(USER, c.path, c.content, { title: c.path });

  let hits = 0;
  let total = 0;
  const misses: string[] = [];
  for (const c of CASES) {
    const want = c.path.endsWith(".md") ? c.path : `${c.path}.md`;
    for (const probe of c.probes) {
      total++;
      const results = await vaultSearch(USER, probe, 5);
      const hit = results.some((r) => r.path === want);
      if (hit) hits++;
      else misses.push(`"${probe}" -> expected ${want}`);
      // eslint-disable-next-line no-console
      console.log(`${hit ? "PASS" : "MISS"}  "${probe}"`);
    }
  }

  for (const c of CASES) await vaultDelete(USER, c.path).catch(() => {});

  const recall = hits / total;
  // eslint-disable-next-line no-console
  console.log(
    `\nRecall@5: ${hits}/${total} = ${(recall * 100).toFixed(0)}%  (threshold ${THRESHOLD * 100}%)`,
  );
  if (misses.length) {
    // eslint-disable-next-line no-console
    console.log("Misses:\n" + misses.map((m) => "  - " + m).join("\n"));
  }
  await closeDb();
  if (recall < THRESHOLD) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: recall ${(recall * 100).toFixed(0)}% below threshold ${THRESHOLD * 100}%`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("OK");
}

void main();
