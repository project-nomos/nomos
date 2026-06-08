# Evals

Runnable checks for the memory + session system. These are not unit tests (those live
next to source as `*.test.ts` and run under `pnpm test`); they exercise real code paths
against a real Postgres, and `eval:agent` boots real servers and makes real model calls.

| Command                | Source                       | What it guards                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm eval:recall`     | `scripts/recall-eval.ts`     | Recall quality. Seeds known facts in the vault, probes them with the natural phrasing a person would use, scores recall@5 against a conservative floor. Fails when recall silently degrades.                                    |
| `pnpm check:isolation` | `scripts/isolation-check.ts` | Per-user isolation. Writes memory as two users through the real application functions, then asserts neither ever sees the other's vault notes, chunks, model, contacts, or wiki (including that a cross-user merge is a no-op). |
| `pnpm eval:agent`      | `eval/agent-eval.ts`         | The end-to-end behavioral eval (below).                                                                                                                                                                                         |

## `eval:agent`

An end-to-end eval of the memory + session management system across **both** power-user
and hosted modes. It boots the daemon's real subsystems (gRPC `NomosAgent`, the Connect
`MobileApi`, `AgentRuntime`, the message queue) and grades behavior, not just plumbing.

What it checks (111 checks when fully wired):

- **Memory recall** from the vault, plus an LLM-as-a-Judge verdict on whether the recalled
  content actually answers the question.
- **Mode contract** of `resolveMemoryUserId`: power-user collapses every channel to one
  owner; hosted keeps users isolated.
- **Per-user isolation** across `vault_notes`, `memory_chunks`, `user_model`, `contacts`.
- **Sessions**: continuity (resume by key) and ephemeral (off-the-record) detection.
- **Derived stores built from the vault** (the wiki/graph "derive from the vault" claim):
  the **knowledge graph** (`backfillGraph` promotes vault notes + contacts into
  `kg_nodes`/`kg_edges`, with cross-tenant traversal proven impossible), the **wiki**
  (`wiki_articles` per-owner write + scoped search, plus the full LLM compile run
  hermetically against a temp `NOMOS_WIKI_DIR`, asserting a hosted compile keeps the
  wiki in the DB and not on disk), and **auto-dream** consolidation (`consolidateMemory` prunes
  stale chunks, scoped to one user).
- **Transcripts + GetMessages**: a non-ephemeral turn persists `transcript_messages`
  (ephemeral does not); `MobileApi.GetMessages` over the authenticated wire returns a
  tenant's own sessions (multi-session) and is empty cross-user.
- **auto_dream_state**: the `autoDream` orchestrator persists its singleton run-state row,
  the run outcome round-trips through `state_json` as a jsonb object (not a double-encoded
  string), the turn gate blocks premature re-runs, and the production cron entry point
  `runAutoDreamCycle` honors the same gate (no-ops right after a run).
- **magic_doc_state**: `writeMagicDoc` records `last_content_hash` + a `state_json` metadata
  bag; `isMagicDocStale` is content-addressed (a hand-edited doc is stale immediately on hash
  mismatch, unchanged content past the interval is stale on the periodic timer); the
  `refreshMagicDocs` runner enumerates marker files under a root, ignores plain `.md`, and
  skips fresh docs with no LLM call.
- **commitments**: per-user proactive-promise store + cross-user isolation.
- **session-resume**: persists an SDK session id and reads it back (guards the jsonb
  double-encoding fixes; a cold `SessionStore` resumes from the DB).
- **cron**: `cron_jobs`/`cron_runs` job + run + stats; owner round-trips.
- **drafts**: `draft_messages` per-owner pending list + the approve/reject/sent state machine.
- **auto-linker**: regression guard for the cross-tenant merge data-loss bug (merges a
  user's own duplicate contacts but never touches another tenant's).
- **managed_files**: content-addressed round-trip + sha-256 hash + idempotent upsert.

Session **scope modes** (channel/sender/peer/channel-peer key shapes) are covered by a
deterministic unit test at `src/sessions/store.test.ts` (runs under `pnpm test`).

- **Mobile endpoints over the Connect wire** (write/list/get/delete vault), and the
  **authenticated hosted wire**: minted EdDSA JWTs prove per-tenant isolation and an
  unauthenticated call is rejected with `Unauthenticated`.
- A **live agent conversation over gRPC `NomosAgent.Chat`** (judged recall across turns).
- The **JWT-gated streaming `MobileApi.Chat` with a real `nomos-server` token** (Better
  Auth issuance, verified against `nomos-server`'s live JWKS). Skipped when `nomos-server`
  is not running.
- A **negative control** proving the judge rejects an answer that misses the rubric.

### Safety

`eval:agent` provisions a throwaway `nomos_eval` database (the same primitives hosted uses
for database-per-customer: `createDatabase` -> `runMigrations` -> `withDatabaseName`),
points `DATABASE_URL` at it for the run, and **drops it on exit**. It never reads or writes
the dev `nomos` database.

### Prerequisites

- `DATABASE_URL` pointing at a Postgres whose role can `CREATE DATABASE` (it provisions
  `nomos_eval`). Loaded from `.env.local` / `.env` like the app, or passed inline.
- An LLM provider for the judge and the live chat turns: `NOMOS_USE_SUBSCRIPTION=true`, or
  `ANTHROPIC_API_KEY`, or Vertex (`CLAUDE_CODE_USE_VERTEX=1` + project/region). Judge and
  chat checks are reported as `SKIP` when none is set.
- Optional: `nomos-server` running on `:4000` for the real-token `MobileApi.Chat` check
  (`cd ../nomos-server && pnpm dev`). When it is down, that check is skipped (~25ms).

### Run

```bash
pnpm eval:agent            # provision -> run -> drop the test DB (default)
pnpm eval:agent --keep     # run, then KEEP nomos_eval (and every row the run wrote) for inspection
pnpm eval:agent --clean    # drop a kept nomos_eval and exit (tidy up after --keep)
```

`--keep` also skips the per-test data cleanup, so afterward you can inspect what each
check wrote, e.g. per-user isolation in the actual tables:

```bash
psql "$DATABASE_URL_BUT_NOMOS_EVAL" -c "SELECT user_id, path FROM vault_notes;"
```

The run prints the exact `psql` connection string on exit. Drop it with `--clean` when done.

Overrides: `NOMOS_SERVER_URL`, `NOMOS_EVAL_EMAIL`, `NOMOS_EVAL_PASSWORD`. Exits non-zero on
any failure.

## Modules

- `judge.ts` -- LLM-as-a-Judge: grades a response against a rubric via the forked-agent
  path (Haiku), returns `{pass, score, reasoning}`. Balanced-brace JSON extraction is
  unit-tested in `judge.test.ts`.
- `wire.ts` -- boots the real `MobileApi` Connect server and builds clients (with an
  optional `authorization: Bearer` interceptor).
- `hosted-auth.ts` -- mints EdDSA JWTs with `node:crypto` and serves a matching JWKS, so
  the authenticated wire can be tested without `nomos-server`.
- `nomos-server-auth.ts` -- gets a JWT the way a real client does: sign up / sign in
  against `nomos-server`, pin the active org, mint via the Better Auth jwt plugin.

## Side effects

The real-token check signs up a fixed `eval-mobile@nomos.local` user in the `nomos_server`
database (reused across runs, the same pattern as the private `hosted-e2e.sh`). It is not
cleaned up.
