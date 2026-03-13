import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Command } from "commander";
import chalk from "chalk";
import { runMigrations } from "../db/migrate.ts";
import { storeMemoryChunk, deleteMemoryBySource, deleteMemoryByPath } from "../db/memory.ts";
import { getDb, closeDb } from "../db/client.ts";
import { chunkText } from "../memory/chunker.ts";
import { generateEmbedding, generateEmbeddings } from "../memory/embeddings.ts";
import { hybridSearch } from "../memory/search.ts";

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".css",
  ".sql",
  ".sh",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".env",
  ".gitignore",
  ".dockerfile",
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || base === "dockerfile" || base === "makefile";
}

function collectFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  const entries = fs.readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile() && isTextFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function registerMemoryCommand(program: Command): void {
  const cmd = program
    .command("memory")
    .description("Manage long-term memory (embeddings and search)");

  cmd
    .command("add <file-or-dir>")
    .description("Add file(s) to memory. For directories, recursively processes text files.")
    .option("-s, --source <source>", "Source label", "manual")
    .action(async (target: string, opts: { source: string }) => {
      try {
        await runMigrations();
        const resolvedTarget = path.resolve(target);

        if (!fs.existsSync(resolvedTarget)) {
          console.error(chalk.red(`Path not found: ${resolvedTarget}`));
          process.exit(1);
        }

        const files = collectFiles(resolvedTarget);
        if (files.length === 0) {
          console.log(chalk.yellow("No text files found."));
          return;
        }

        console.log(chalk.dim(`Processing ${files.length} file(s)...`));

        let totalChunks = 0;
        for (const filePath of files) {
          const content = fs.readFileSync(filePath, "utf-8");
          const chunks = chunkText(content);
          if (chunks.length === 0) continue;

          const texts = chunks.map((c) => c.text);
          const embeddings = await generateEmbeddings(texts);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const hash = crypto.createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
            const id = `${path.relative(process.cwd(), filePath)}:${chunk.startLine}-${chunk.endLine}`;

            await storeMemoryChunk({
              id,
              source: opts.source,
              path: filePath,
              text: chunk.text,
              embedding: embeddings[i],
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              hash,
              model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
            });
          }

          totalChunks += chunks.length;
          console.log(
            chalk.dim(`  ${path.relative(process.cwd(), filePath)}: ${chunks.length} chunk(s)`),
          );
        }

        console.log(chalk.green(`Added ${totalChunks} chunks from ${files.length} file(s)`));
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("search <query>")
    .description("Search memory using hybrid vector + text search")
    .option("-n, --limit <n>", "Max results", "5")
    .action(async (query: string, opts: { limit: string }) => {
      try {
        await runMigrations();
        const limit = parseInt(opts.limit, 10);

        const embedding = await generateEmbedding(query);
        const results = await hybridSearch(query, embedding, limit);

        if (results.length === 0) {
          console.log(chalk.yellow("No results found."));
          return;
        }

        for (const result of results) {
          console.log(
            chalk.bold(result.path ?? result.source) +
              chalk.dim(` (score: ${result.score.toFixed(4)})`),
          );
          // Show a preview of the text
          const preview = result.text.slice(0, 200).replace(/\n/g, " ");
          console.log(chalk.dim(`  ${preview}${result.text.length > 200 ? "..." : ""}`));
          console.log();
        }
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("list")
    .description("List all memory sources")
    .action(async () => {
      try {
        await runMigrations();
        const sql = getDb();

        const rows = await sql<Array<{ source: string; path_count: string; chunk_count: string }>>`
          SELECT
            source,
            COUNT(DISTINCT path) as path_count,
            COUNT(*) as chunk_count
          FROM memory_chunks
          GROUP BY source
          ORDER BY source
        `;

        if (rows.length === 0) {
          console.log(chalk.dim("No memory chunks stored."));
          return;
        }

        for (const row of rows) {
          console.log(
            chalk.bold(row.source) +
              chalk.dim(` - ${row.path_count} path(s), ${row.chunk_count} chunk(s)`),
          );
        }
      } finally {
        await closeDb();
      }
    });

  cmd
    .command("clear")
    .description("Delete memory chunks")
    .option("-s, --source <source>", "Delete only chunks with this source label")
    .option("-p, --path <path>", "Delete only chunks from this file path")
    .action(async (opts: { source?: string; path?: string }) => {
      try {
        await runMigrations();

        let count: number;
        if (opts.source) {
          count = await deleteMemoryBySource(opts.source);
          console.log(chalk.green(`Deleted ${count} chunk(s) with source "${opts.source}"`));
        } else if (opts.path) {
          const resolvedPath = path.resolve(opts.path);
          count = await deleteMemoryByPath(resolvedPath);
          console.log(chalk.green(`Deleted ${count} chunk(s) from path "${resolvedPath}"`));
        } else {
          const sql = getDb();
          const result = await sql`DELETE FROM memory_chunks`;
          count = result.count;
          console.log(chalk.green(`Deleted all ${count} memory chunk(s)`));
        }
      } finally {
        await closeDb();
      }
    });
}
