# Memory System

How Nomos remembers across conversations: a per-user **vault** that is the durable source
of truth, four in-loop tools the agent uses to read and write it, and a reasoning-first
digest injected every turn so continuity does not depend on the agent remembering to
search.

## Overview

The naive design is one long conversation: every message appends to a single transcript
and the model has "everything" in context. It works for a week, then the context window
fills, compaction kicks in, and the assistant quietly forgets your dentist's name. The
session _was_ the memory, so compressing the session is data loss.

Nomos splits the two apart:

- The **session** is a disposable working buffer. One rolling SDK session per user, with
  native compaction. Rotating it is never data loss. See
  [session management](session-management.md).
- The **vault** is durable, separate, per-user memory: a markdown knowledge base in
  Postgres that you can open, read, and correct.

The compiled [knowledge wiki](knowledge-wiki.md) and [knowledge graph](knowledge-graph.md)
are _derived from_ the vault; the vault is the source of truth.

## Architecture

```
              Agent doors (in-loop MCP tools)
   memory_read/write/list/forget   memory_search   graph_search   load_thread
            |                            |               |              |
            v                            v               v              v
   +-------------------------------------------------+   +----------+   +---------+
   |                 THE VAULT (per-user)            |   |  kg_*    |   | rolling |
   |  vault_notes: markdown + [[wikilinks]]          |-->|  graph   |   | SDK     |
   |  scoped by user_id                              |   | (derived)|   | session |
   +-------------------------------------------------+   +----------+   +---------+
            |                    ^
            | (every turn)       | browse + edit
            v                    |
   reasoning-first digest    Human door: settings /admin/vault + MobileApi RPCs
   injected into the prompt
```

## The vault

A per-user markdown knowledge base in its own `vault_notes` table: notes with
`[[wikilinks]]`, a `profile.md`, a `people/` directory, `procedures/` for "how this person
likes their inbox triaged." It has **two doors**:

- The agent's door is the memory tools (below).
- _Your_ door is a browser: a page in settings lists every note your clone has written
  about you and lets you fix it, and the same data is exposed over gRPC for the mobile app.
  Memory you cannot inspect is memory you cannot trust.

Writes **revise** (upsert by path), they do not append, so the vault never accretes ten
contradictory notes about your coffee order.

## The four tools

Memory is exposed as tools the agent opens mid-thought, the same way it reads a file. The
retrieval is in the agent loop, visible in the transcript, and debuggable -- not a hidden
router that guesses what to inject.

- **`memory_read` / `memory_write` / `memory_list` / `memory_forget`** -- the agent's
  notebook over the vault.
- **`memory_search`** -- semantic recall: vector + full-text hybrid over everything
  indexed, for when the agent does not know the exact note to open. Vault writes also index
  into the vector store, so self-written notes are searchable by meaning, not just keyword.
- **`graph_search`** -- relational questions ("who is Dana, how do I know her") against the
  typed, bitemporal [knowledge graph](knowledge-graph.md).
- **`load_thread`** -- pulls an exact past transcript from Postgres when wording matters.

## Reasoning-first digest

Tools have one failure mode: the agent has to _decide_ to use them, and sometimes it just
does not. So continuity is not left to chance. Every turn, a compact digest of the user
model and `profile.md` is injected into the system prompt, so the baseline "who am I
talking to" is always present; the tools are for going deeper. Reason from a baseline of
knowing the person; escalate to retrieval when you need more.

## Per-user scoping, and both modes

The same memory system runs in the open-source power-user setup and the hosted
multi-tenant service. Isolation is two layers:

- **The connection.** Power-user uses one local database. Hosted is database-per-customer:
  each customer instance is a separate process whose `DATABASE_URL` points at its own
  database.
- **The row (zero-trust on top).** Every per-user store also filters by `user_id` at the
  query layer: `vault_notes`, `memory_chunks`, `user_model`, `wiki_articles`, `contacts`,
  `commitments`, and the `kg_*` graph. The owner is resolved once at the request boundary
  by `resolveMemoryUserId`: power-user collapses every channel (Slack, iMessage, CLI) to a
  single `local` owner so your one brain is not fragmented; hosted keeps the authenticated
  tenant; synthetic actors (cron, an agent-to-agent DID) collapse onto the instance owner.

This matters for the family/team plan, where multiple members share one customer database
and only the `user_id` filter keeps their memories apart.

## Lifecycle details

- **Off the record.** A session whose key carries an `ephemeral` segment skips the entire
  automatic capture path: no indexing, no extraction. The deliberate memory tools still
  work, so "actually, remember this" can, but nothing is captured by default.
- **Forget means forget.** "Forget that" deletes the note from the vault, through the tool,
  the settings page, or the mobile API. There is no shadow copy; the vector chunk goes too.
- **Stay correctable.** When the assistant leans on memory it names the source in passing
  ("re: your dentist appointment"), so you can catch it being wrong before it acts.

## Storage

In `src/db/schema.sql`:

- `vault_notes` -- the vault (markdown + FTS), `user_id`-scoped. Source of truth.
- `memory_chunks` -- `text` + `vector(768)` + metadata, for hybrid semantic recall.
- `user_model` -- accumulated preferences/facts with confidence, `UNIQUE(user_id, category, key)`.
- `wiki_articles` -- the compiled [wiki](knowledge-wiki.md), derived from the vault.
- `kg_nodes` / `kg_edges` -- the [knowledge graph](knowledge-graph.md), derived from the vault.

Content-hash chunk ids are user-namespaced, so identical content across users never
collides.

## Testing

The memory system has runnable evals (see [eval/README.md](../eval/README.md)):

- `pnpm eval:recall` -- recall@5 regression guard over the vault.
- `pnpm check:isolation` -- writes as two users through the real functions, asserts no
  cross-user leak.
- `pnpm eval:agent` -- end-to-end behavioral eval (memory + sessions in both modes, the
  authenticated gRPC/mobile wire, an LLM-as-a-judge), against a throwaway database.
- `pnpm eval:audit` -- the full gate: `eval:agent`, then the Opus-4.8 label audit + the
  spec-driven feature-manifest audit (verifies every feature is wired and its DB effects
  land), then drops the DB.

## Code map

- `src/memory/vault.ts` -- the vault (read/write/search/delete + vector indexing).
- `src/sdk/vault-mcp.ts` -- the in-loop memory tools.
- `src/memory/digest.ts` -- the reasoning-first digest.
- `src/auth/tenant-context.ts` -- `resolveMemoryUserId`, the owner boundary.
- `src/memory/trace.ts` -- structured recall/write traces + recall-hit-rate.
