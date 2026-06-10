# Knowledge Wiki

A Karpathy-style compiled knowledge base that transforms raw ingested messages into structured, LLM-maintained markdown articles.

## Overview

Pure vector search (RAG) works for fuzzy recall, but at personal scale (~100K messages), a structured wiki compiled by an LLM is more effective for synthesized understanding. The knowledge wiki is a compiled layer on top of pgvector that the agent reads first, falling back to RAG for details.

## Architecture

```
Raw messages (pgvector)  -->  Knowledge Compiler (LLM)  -->  Wiki (DB + disk)
                                     ^                          |
                               Periodic cron job           Agent reads wiki first,
                               (every 1h)                  falls back to RAG
```

## Wiki Structure

```
~/.nomos/wiki/
  _index.md              # Master index with all article summaries
  contacts/
    _index.md            # Contact directory
    sarah-chen.md        # Everything about Sarah: role, topics, recent
  topics/
    _index.md
    kubernetes.md        # Cross-contact topic synthesis
    q2-launch.md
  style/
    _index.md
    global-voice.md      # Compiled writing style guide
  timeline/
    2026-04.md           # Monthly activity digest
```

## Storage: DB-Primary, Disk-as-Cache

Wiki articles are stored in the `wiki_articles` database table (source of truth) and synced to `~/.nomos/wiki/` as a readable cache. If the disk copy is lost, it's a cheap re-sync from DB — no LLM re-compilation needed.

### `wiki_articles` table

| Column          | Type   | Description                            |
| --------------- | ------ | -------------------------------------- |
| `path`          | TEXT   | e.g., `contacts/sarah-chen.md`         |
| `title`         | TEXT   | Article title                          |
| `content`       | TEXT   | Full markdown content                  |
| `category`      | TEXT   | contact, topic, style, timeline, index |
| `backlinks`     | TEXT[] | Paths of articles that link here       |
| `word_count`    | INT    | Content word count                     |
| `compile_model` | TEXT   | Model used for last compilation        |

## How It Works

1. **Query** — Reads recent `memory_chunks` since last compilation
2. **Group** — Groups by contact and topic
3. **Compile** — Uses a forked agent (Sonnet for quality) to compile/update wiki articles
4. **Store** — Writes to `wiki_articles` table + syncs to disk
5. **Index** — Auto-maintains `_index.md` files with summaries and backlinks

## Agent Integration

When processing a message, the agent runtime:

1. Calls `getRelevantArticles(userId, prompt)` (`wiki-reader.ts`), which runs **FTS over the owner's `wiki_articles`** for the turn and returns the top matches within a ~4000-char budget
2. Appends those articles to `systemPromptAppend` (after the stable prefix, so the prompt cache is preserved)
3. Falls back to vector search (`memory_search`) for details not in the wiki

There is no separate `wiki_search` MCP tool — wiki retrieval is automatic per turn, and the agent can also reach the same content through `memory_search`.

## Relationship to Other Systems

| System             | What it compiles                                        | Scope                 |
| ------------------ | ------------------------------------------------------- | --------------------- |
| **Knowledge wiki** | Ingested communications (what you said to others)       | Structured articles   |
| **Auto-dream**     | Conversation memory (what the agent discussed with you) | Memory consolidation  |
| **Magic docs**     | Project documentation                                   | Auto-updated markdown |

All three coexist — they serve different knowledge layers.

## Configuration

The compilation knobs are runtime config. `resolveWiki()` (in
`src/memory/knowledge-compiler.ts`) reads them on every run with the standard
precedence (DB `config` row > env var > built-in default), so editing the model,
max-articles, or the on/off gate in the Settings UI or the DB takes effect on the
next compile without a redeploy:

| Config key (DB)             | Env var                           | Default             | Meaning                                            |
| --------------------------- | --------------------------------- | ------------------- | -------------------------------------------------- |
| `app.wikiEnabled`           | `NOMOS_WIKI_ENABLED`              | `true`              | Master on/off. `false` makes the compiler a no-op  |
| `app.wikiCompileInterval`   | `NOMOS_WIKI_COMPILE_INTERVAL`     | `"1h"`              | Cron cadence **and** the cooldown between compiles |
| `app.wikiCompileModel`      | `NOMOS_WIKI_COMPILE_MODEL`        | `claude-sonnet-4-6` | Model for compilation (quality matters)            |
| `app.wikiMaxArticlesPerRun` | `NOMOS_WIKI_MAX_ARTICLES_PER_RUN` | `20`                | Cap on articles touched per compilation run        |

The interval drives two gates that together set "how often it runs": the seeded
`wiki-compile` cron cadence (`src/daemon/gateway.ts`) and the per-owner cooldown
that refuses to recompile sooner (a Redis key in hosted mode, a lock file in
power-user mode). The cooldown picks up a changed interval immediately (it is read
every compile); the cron cadence is reconciled to the config value on daemon
**boot**, so a changed interval fully takes effect after the next restart. An
invalid duration string falls back to `1h`.

## Privacy

- No PII in wiki article titles — uses contact IDs, resolves names at read time
- Wiki/style data never leaves the system in agent responses to third parties
- All wiki articles are `user_id`-scoped, so deleting an owner's rows (or dropping their per-customer database in hosted mode) removes their wiki entirely
