# Knowledge Wiki

A Karpathy-style compiled knowledge base that transforms raw ingested messages into structured, LLM-maintained markdown articles.

## Overview

Pure vector search (RAG) works for fuzzy recall, but at personal scale (~100K messages), a structured wiki compiled by an LLM is more effective for synthesized understanding. The knowledge wiki is a compiled layer on top of pgvector that the agent reads first, falling back to RAG for details.

## Architecture

```
Raw messages (pgvector)  -->  Knowledge Compiler (LLM)  -->  Wiki (DB + disk)
                                     ^                          |
                               Periodic cron job           Agent reads wiki first,
                               (every 2h)                  falls back to RAG
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

1. Checks the wiki for relevant articles via `wiki-reader.ts` (reads `_index.md`, identifies matches by topic/contact)
2. Injects matched articles as context
3. Falls back to vector search (`memory_search`) for details not in the wiki

The `wiki_search` MCP tool is also available for explicit wiki queries.

## Relationship to Other Systems

| System             | What it compiles                                        | Scope                 |
| ------------------ | ------------------------------------------------------- | --------------------- |
| **Knowledge wiki** | Ingested communications (what you said to others)       | Structured articles   |
| **Auto-dream**     | Conversation memory (what the agent discussed with you) | Memory consolidation  |
| **Magic docs**     | Project documentation                                   | Auto-updated markdown |

All three coexist — they serve different knowledge layers.

## Configuration

| Key                         | Default             | Description                             |
| --------------------------- | ------------------- | --------------------------------------- |
| `app.wikiEnabled`           | `true`              | Enable/disable knowledge compilation    |
| `app.wikiCompileInterval`   | `"2h"`              | How often the compiler runs             |
| `app.wikiCompileModel`      | `claude-sonnet-4-6` | Model for compilation (quality matters) |
| `app.wikiMaxArticlesPerRun` | `20`                | Cap articles per compilation run        |

## Privacy

- No PII in wiki article titles — uses contact IDs, resolves names at read time
- Wiki/style data never leaves the system in agent responses to third parties
- Per-contact data deletion: `nomos contacts forget <id>` removes all associated wiki articles
