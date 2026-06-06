/**
 * CLI command: nomos brain
 *
 * Manage the knowledge graph (BRAIN) — typed entity nodes + bitemporal edges
 * overlaid on the existing memory. See BRAIN_PLAN.md.
 *
 * Usage:
 *   nomos brain backfill          Promote contacts + wiki into the graph (idempotent)
 *   nomos brain stats             Show node/edge counts by kind/relation
 *   nomos brain search <query>    Resolve an entity by name
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDb, closeDb } from "../db/client.ts";
import { LOCAL_TENANT } from "../auth/tenant-context.ts";

export function registerBrainCommand(program: Command): void {
  const brain = program
    .command("brain")
    .description("Manage the knowledge graph (typed entities + relationships)");

  brain
    .command("backfill")
    .description("Promote existing contacts + wiki into the knowledge graph (idempotent)")
    .action(async () => {
      getDb();
      try {
        const { backfillGraph } = await import("../memory/graph.ts");
        const { syncWikiBodyLinks, syncWikiMOCs } = await import("../memory/graph-writer.ts");
        console.log(chalk.blue("Backfilling the knowledge graph from contacts + wiki..."));
        const r = await backfillGraph(LOCAL_TENANT);
        const wl = await syncWikiBodyLinks(LOCAL_TENANT);
        const moc = await syncWikiMOCs(LOCAL_TENANT);
        console.log(
          chalk.green(
            `Done: +${r.personNodes} person nodes, +${r.wikiNodes} wiki nodes, +${r.linkEdges} backlink edges, +${wl.edges} inline [[link]] edges, +${moc.mocs} topic hubs`,
          ),
        );
        console.log(chalk.dim("Tip: run `nomos brain semantic` to add meaning-based links."));
        console.log(chalk.dim("View it at the Settings UI → Knowledge Graph (/admin/graph)."));
      } finally {
        await closeDb();
      }
    });

  brain
    .command("stats")
    .description("Show knowledge-graph counts by node kind and relationship type")
    .action(async () => {
      const sql = getDb();
      try {
        const kinds = await sql<{ kind: string; count: string }[]>`
          SELECT kind, count(*)::text AS count FROM kg_nodes GROUP BY kind ORDER BY count(*) DESC
        `;
        const rels = await sql<{ rel_type: string; count: string }[]>`
          SELECT rel_type, count(*)::text AS count FROM kg_edges WHERE invalid_at IS NULL
          GROUP BY rel_type ORDER BY count(*) DESC
        `;

        if (kinds.length === 0) {
          console.log(chalk.dim("Graph is empty. Run `nomos brain backfill` to seed it."));
          return;
        }

        console.log(chalk.bold("\nNodes by kind"));
        for (const k of kinds) console.log(`  ${k.kind.padEnd(12)} ${chalk.cyan(k.count)}`);
        console.log(chalk.bold("\nEdges by relation (current)"));
        for (const r of rels) console.log(`  ${r.rel_type.padEnd(16)} ${chalk.cyan(r.count)}`);
        console.log();
      } catch (err) {
        console.log(
          chalk.red(
            `Could not read the graph: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        console.log(chalk.dim("Run `nomos db migrate` first to create the kg_* tables."));
      } finally {
        await closeDb();
      }
    });

  brain
    .command("search <query>")
    .description("Resolve an entity by name in the knowledge graph")
    .option("-l, --limit <n>", "Max results", "10")
    .action(async (query: string, opts: { limit: string }) => {
      getDb();
      try {
        const { searchNodes } = await import("../memory/graph.ts");
        const nodes = await searchNodes(LOCAL_TENANT, query, { limit: Number(opts.limit) || 10 });
        if (nodes.length === 0) {
          console.log(chalk.dim(`No entity matching "${query}".`));
          return;
        }
        console.log(chalk.bold(`\nMatches for "${query}"\n`));
        for (const n of nodes) {
          const aka = n.aliases.length ? chalk.dim(` (aka ${n.aliases.join(", ")})`) : "";
          console.log(
            `  ${chalk.cyan(n.kind.padEnd(10))} ${n.name}${aka}  ${chalk.dim(n.id.slice(0, 8))}`,
          );
        }
        console.log();
      } finally {
        await closeDb();
      }
    });

  brain
    .command("semantic")
    .description("Embed nodes and materialize meaning-based (semantic) edges")
    .option("-t, --threshold <n>", "Min cosine similarity (0-1)", "0.85")
    .action(async (opts: { threshold: string }) => {
      getDb();
      try {
        const { embedMissingNodes, materializeSemanticEdges } =
          await import("../memory/graph-semantic.ts");
        console.log(chalk.blue("Embedding nodes..."));
        const e = await embedMissingNodes(LOCAL_TENANT);
        console.log(chalk.dim(`  embedded ${e.embedded} node(s)`));
        console.log(chalk.blue("Materializing semantic edges..."));
        const s = await materializeSemanticEdges(LOCAL_TENANT, {
          threshold: Number(opts.threshold) || 0.85,
        });
        console.log(
          chalk.green(`Done: ${s.edges} semantic edges across ${s.nodes} embedded nodes`),
        );
      } finally {
        await closeDb();
      }
    });

  brain
    .command("export <query>")
    .description("Export an entity's local graph to a JSON Canvas (.canvas) file")
    .option("-o, --out <file>", "Output path (default: <name>.canvas)")
    .option("-d, --depth <n>", "Hops", "2")
    .action(async (query: string, opts: { out?: string; depth: string }) => {
      getDb();
      try {
        const fs = await import("node:fs");
        const { searchNodes, neighborhood, subgraphToCanvas } = await import("../memory/graph.ts");
        const matches = await searchNodes(LOCAL_TENANT, query, { limit: 1 });
        if (matches.length === 0) {
          console.log(chalk.dim(`No entity matching "${query}".`));
          return;
        }
        const top = matches[0]!;
        const sub = await neighborhood(LOCAL_TENANT, top.id, {
          depth: Number(opts.depth) || 2,
          limit: 500,
        });
        const canvas = subgraphToCanvas(sub);
        const out = opts.out ?? `${top.name.replace(/[^\w]+/g, "-").toLowerCase()}.canvas`;
        fs.writeFileSync(out, JSON.stringify(canvas, null, 2));
        console.log(
          chalk.green(
            `Exported ${canvas.nodes.length} nodes / ${canvas.edges.length} edges → ${out}`,
          ),
        );
      } finally {
        await closeDb();
      }
    });
}
