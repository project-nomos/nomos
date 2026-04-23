/**
 * CLI command: nomos wiki
 *
 * Manage the knowledge wiki -- compiled articles about contacts,
 * projects, and topics built from the agent's accumulated knowledge.
 *
 * Usage:
 *   nomos wiki compile [--force]   Compile/update wiki articles
 *   nomos wiki list                List all wiki articles
 *   nomos wiki read <path>         Read a specific article
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDb, closeDb } from "../db/client.ts";

export function registerWikiCommand(program: Command): void {
  const wiki = program
    .command("wiki")
    .description("Manage the knowledge wiki (compiled articles about contacts, projects, topics)");

  wiki
    .command("compile")
    .description("Compile/update wiki articles from accumulated knowledge")
    .option("--force", "Skip cooldown and compile immediately")
    .action(async (opts) => {
      getDb();
      try {
        const { compileKnowledge } = await import("../memory/knowledge-compiler.ts");
        console.log(chalk.blue("Compiling knowledge wiki..."));
        const result = await compileKnowledge({ force: opts.force });

        if (
          result.errors.length > 0 &&
          result.articlesCreated === 0 &&
          result.articlesUpdated === 0
        ) {
          console.log(chalk.dim(result.errors[0]));
          return;
        }

        console.log(
          chalk.green(`Done: ${result.articlesCreated} created, ${result.articlesUpdated} updated`),
        );
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.log(chalk.red(`  Error: ${err}`));
          }
        }
      } finally {
        await closeDb();
      }
    });

  wiki
    .command("list")
    .description("List all wiki articles")
    .action(async () => {
      getDb();
      try {
        const { listArticles } = await import("../db/wiki.ts");
        const articles = await listArticles();

        if (articles.length === 0) {
          console.log(chalk.dim("No wiki articles. Run `nomos wiki compile` to generate."));
          return;
        }

        console.log(chalk.bold("\nKnowledge Wiki\n"));
        const categories = new Map<string, typeof articles>();
        for (const a of articles) {
          const group = categories.get(a.category) ?? [];
          group.push(a);
          categories.set(a.category, group);
        }

        for (const [category, items] of categories) {
          if (category === "index") continue;
          console.log(chalk.blue(`  ${category}/`));
          for (const item of items) {
            const age = timeSince(new Date(item.compiled_at));
            console.log(`    ${item.title.padEnd(30)} ${chalk.dim(age)}`);
          }
        }
        console.log();
      } finally {
        await closeDb();
      }
    });

  wiki
    .command("read <path>")
    .description("Read a wiki article (e.g., contacts/suren)")
    .action(async (articlePath: string) => {
      getDb();
      try {
        const { getArticle } = await import("../db/wiki.ts");
        // Normalize path
        let p = articlePath;
        if (!p.endsWith(".md")) p += ".md";
        if (!p.includes("/")) p = `contacts/${p}`;

        const article = await getArticle(p);
        if (!article) {
          console.log(chalk.red(`Article not found: ${p}`));
          console.log(chalk.dim("Run `nomos wiki list` to see available articles."));
          return;
        }

        console.log(article.content);
      } finally {
        await closeDb();
      }
    });
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
