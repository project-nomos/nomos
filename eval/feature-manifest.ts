/**
 * Feature manifest -- the audit's INDEPENDENT target.
 *
 * Regression tests only fail on things a human wrote a check for, so they are
 * structurally blind to three bug classes: dormant code (exists, nothing calls
 * it), empty outputs (a column/effect is never populated), and drift (behavior
 * != intent). This file states, per feature, what it SHOULD do and its
 * observable effects -- a contract the spec audit (eval/agent-eval.ts
 * runSpecAudit) reasons against instead of trusting the (same-blind-spot) tests.
 *
 * Keep entries at the level of INTENT + EFFECTS, not implementation. Every cron
 * sentinel must have an entry here (enforced by the meta-check), so shipping a
 * background feature without declaring its contract is itself a failure.
 */

export type Trigger =
  | { kind: "cron"; sentinel: string; schedule: string; fanOut?: boolean }
  | { kind: "turn"; gate?: string }
  | { kind: "boot" }
  | { kind: "cli"; command: string }
  | { kind: "mcp-tool"; name: string };

export interface FeatureEffect {
  /** A checkable claim about persisted/observable state, for the audit to reason about. */
  claim: string;
  /**
   * Optional deterministic SQL: a single-column count query. `expect: "nonzero"`
   * means the effect is present in the populated nomos_eval; "zero" means it
   * must NOT appear. Runs only when the eval exercises the feature.
   */
  sql?: { query: string; expect: "nonzero" | "zero" };
  /**
   * Optional double-encode guard. Flags rows where the jsonb column reads back as
   * a STRING whose text is itself JSON (`{`/`[`) -- the signature of JSON.stringify
   * into a jsonb column. Legitimate scalar strings (e.g. value '"blue"') are NOT
   * flagged, so this is safe on columns that mix objects and scalars.
   */
  noDoubleEncode?: { table: string; column: string; where?: string };
  /** True when the eval does NOT exercise this effect (so an empty result is a coverage gap, not a bug). */
  notExercised?: boolean;
}

export interface FeatureSpec {
  id: string;
  summary: string;
  trigger: Trigger;
  /** Exported symbols a live production path must call. Liveness greps for callers of these. */
  entry: string[];
  effects: FeatureEffect[];
  invariants?: string[];
}

export const FEATURES: FeatureSpec[] = [
  // ── Background (cron sentinels) ──
  {
    id: "wiki-compile",
    summary:
      "Compile the per-owner knowledge wiki from the vault on a schedule. Cadence, cooldown, model, max-articles and an on/off gate are read from app.wiki* config (resolveWiki), not hardcoded.",
    trigger: { kind: "cron", sentinel: "__wiki_compile__", schedule: "1h", fanOut: true },
    entry: ["compileKnowledge", "resolveWiki"],
    effects: [
      {
        claim: "wiki_articles are produced with content + a compile_model for content articles",
        sql: {
          query: "SELECT count(*) FROM wiki_articles WHERE compile_model IS NOT NULL",
          expect: "nonzero",
        },
      },
      {
        claim: "compiled articles carry [[backlinks]] cross-links",
        sql: {
          query: "SELECT count(*) FROM wiki_articles WHERE backlinks <> '{}'",
          expect: "nonzero",
        },
      },
      {
        claim:
          "the wiki compile settings are present in the config table (so resolveWiki reads them, not constants)",
        sql: {
          query:
            "SELECT count(*) FROM config WHERE key IN ('app.wikiEnabled','app.wikiCompileInterval','app.wikiCompileModel','app.wikiMaxArticlesPerRun')",
          expect: "nonzero",
        },
      },
    ],
    invariants: [
      "per-owner scoped (user_id)",
      "interval/model/maxArticles/enabled resolved from app.wiki* config via resolveWiki (constants are fallback defaults only)",
      "app.wikiEnabled=false makes compileKnowledge a no-op (hard off-switch)",
    ],
  },
  {
    id: "auto-dream",
    summary: "Background memory consolidation per owner, singleton-gated + leased.",
    trigger: { kind: "cron", sentinel: "__auto_dream__", schedule: "6h", fanOut: true },
    entry: ["runAutoDreamCycle"],
    effects: [
      {
        claim: "auto_dream_state persists the run outcome in state_json as a jsonb object",
        sql: {
          query: "SELECT count(*) FROM auto_dream_state WHERE jsonb_typeof(state_json) = 'object'",
          expect: "nonzero",
        },
        noDoubleEncode: {
          table: "auto_dream_state",
          column: "state_json",
          where: "state_json IS NOT NULL",
        },
      },
    ],
    invariants: ["singleton row (id=1)", "no jsonb double-encode"],
  },
  {
    id: "magic-docs",
    summary: "Refresh stale self-updating docs, content-addressed.",
    trigger: { kind: "cron", sentinel: "__magic_docs__", schedule: "1h" },
    entry: ["refreshMagicDocs"],
    effects: [
      {
        claim: "magic_doc_state records last_content_hash (sha256) + a state_json metadata object",
        sql: {
          query: "SELECT count(*) FROM magic_doc_state WHERE last_content_hash IS NOT NULL",
          expect: "nonzero",
        },
        noDoubleEncode: {
          table: "magic_doc_state",
          column: "state_json",
          where: "state_json IS NOT NULL",
        },
      },
    ],
  },
  {
    id: "commitment-reminders",
    summary: "Deliver due commitment reminders per owner to the notification channel.",
    trigger: { kind: "cron", sentinel: "__commitment_reminders__", schedule: "1h", fanOut: true },
    entry: ["runCommitmentReminders"],
    effects: [
      {
        claim: "delivers one text block per owner with due reminders (behavioral)",
        notExercised: true,
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "triage-digest",
    summary: "Daily inbox triage digest per owner.",
    trigger: { kind: "cron", sentinel: "__triage_digest__", schedule: "0 17 * * *", fanOut: true },
    entry: ["runTriageDigest"],
    effects: [
      {
        claim: "returns a per-owner digest of high/medium priority senders (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "style-analyze",
    summary: "Re-derive each owner's writing voice from sent messages (opt-in styleMatching).",
    trigger: { kind: "cron", sentinel: "__style_analyze__", schedule: "24h", fanOut: true },
    entry: ["analyzeStyle"],
    effects: [
      {
        claim: "style_profiles store a per-user voice profile as a jsonb object",
        sql: {
          query: "SELECT count(*) FROM style_profiles WHERE jsonb_typeof(profile) = 'object'",
          expect: "nonzero",
        },
        noDoubleEncode: { table: "style_profiles", column: "profile" },
      },
    ],
    invariants: ["per-user scoped (UNIQUE user_id, scope)", "no jsonb double-encode"],
  },
  {
    id: "relationship-narrative",
    summary:
      "Weekly per-owner: the agent writes a first-person 'how we've come to work together' narrative from the learned user_model into an editable relationship.md vault note — closing the understanding != articulation gap. Forked-Haiku, NOMOS_ADAPTIVE_MEMORY-gated.",
    trigger: {
      kind: "cron",
      sentinel: "__relationship_narrative__",
      schedule: "168h",
      fanOut: true,
    },
    entry: ["writeRelationshipNarrative"],
    effects: [
      {
        claim:
          "an agent-authored relationship narrative is written as an editable relationship.md vault note",
        sql: {
          query: "SELECT count(*) FROM vault_notes WHERE path = 'relationship.md'",
          expect: "nonzero",
        },
      },
    ],
    invariants: [
      "per-owner scoped (user_id)",
      "grounded in the learned user_model; no fabrication",
    ],
  },
  {
    id: "graph-semantic",
    summary: "Embed kg_nodes + materialize meaning-based edges per owner.",
    trigger: { kind: "cron", sentinel: "__graph_semantic__", schedule: "6h", fanOut: true },
    entry: ["embedMissingNodes", "materializeSemanticEdges"],
    effects: [
      {
        claim: "kg_nodes.embedding is populated so the HNSW vector index is live",
        sql: {
          query: "SELECT count(*) FROM kg_nodes WHERE embedding IS NOT NULL",
          expect: "nonzero",
        },
      },
      {
        claim: "vault/wiki kg_nodes carry a summary from their source body",
        sql: {
          query: "SELECT count(*) FROM kg_nodes WHERE summary IS NOT NULL",
          expect: "nonzero",
        },
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "delta-sync",
    summary: "Incremental re-sync of ingestion sources.",
    trigger: { kind: "cron", sentinel: "__delta_sync__", schedule: "6h" },
    entry: ["registerDeltaSyncJobs"],
    effects: [{ claim: "emits ingest:trigger for delta runs (behavioral)", notExercised: true }],
  },
  {
    id: "studio-gc",
    summary:
      "Daily Studio object/row cleanup per owner: expire unconfirmed uploads (assets stuck pending past a TTL) and aged intermediate edit results no longer at the chain head, dropping their objects. Originals + the live head output are kept; the DB is the single clock (rows expired before object delete).",
    trigger: { kind: "cron", sentinel: "__studio_gc__", schedule: "24h", fanOut: true },
    entry: ["runStudioGc", "runStudioGcForUser"],
    effects: [
      {
        claim: "GC marks expired Studio rows (status = 'expired')",
        sql: {
          query: "SELECT count(*) FROM studio_edits WHERE status = 'expired'",
          expect: "nonzero",
        },
        notExercised: true, // the eval does not age rows past the TTL
      },
    ],
    invariants: [
      "the original asset object is never deleted by GC",
      "a row is marked expired before its object is deleted",
      "every GC query is user_id-filtered",
    ],
  },

  // ── Studio (hosted-only feature) ──
  {
    id: "studio",
    summary:
      "Hosted-only media asset + edit pipeline (gated). Immutable original + a non-destructive op chain: validate op -> consent gate (cloud ops only) -> append (optimistic concurrency: parent must be a done+output edit) + idempotency -> provider (local-sharp deterministic / mediapipe-sidecar deterministic / GCP generative) -> identity gate (face-risk ops) -> persist output + preview. Manual on-device renders (adjust/makeup/reshape/hair/body) commit via the deviceRender op (the client uploads its own pixels, re-encoded server-side). retouch routes to the deterministic sidecar when up, else the generative cloud fallback. Phase-3 depth ops (muscle/hairstyle/beard/relight/expand/sky) are generative. Per-user scoped.",
    trigger: { kind: "turn", gate: "studio" },
    entry: [
      "buildStudioMcpServer",
      "buildStudioEngine",
      "assertIdentityPreserved",
      "ensureStudioSidecar",
      "listAssets",
      "suggestEdits",
    ],
    effects: [
      {
        claim: "uploaded originals are recorded as studio_assets rows",
        sql: { query: "SELECT count(*) FROM studio_assets", expect: "nonzero" },
        notExercised: true,
      },
      {
        claim: "each edit appends a completed studio_edits op row",
        sql: {
          query: "SELECT count(*) FROM studio_edits WHERE status = 'done'",
          expect: "nonzero",
        },
        notExercised: true,
      },
      {
        claim: "on-device renders commit as deviceRender edits (client-uploaded pixels)",
        sql: {
          query: "SELECT count(*) FROM studio_edits WHERE op = 'deviceRender' AND status = 'done'",
          expect: "nonzero",
        },
        notExercised: true,
      },
      {
        claim: "one-tap retouch records a done studio_edits row (sidecar or cloud fallback)",
        sql: {
          query: "SELECT count(*) FROM studio_edits WHERE op = 'retouch' AND status = 'done'",
          expect: "nonzero",
        },
        notExercised: true,
      },
      {
        claim: "Phase-3 generative depth ops record done studio_edits rows",
        sql: {
          query:
            "SELECT count(*) FROM studio_edits WHERE op IN ('muscle','hairstyle','beard','relight','expand','sky') AND status = 'done'",
          expect: "nonzero",
        },
        notExercised: true,
      },
      {
        claim: "op params are stored as a jsonb object, never double-encoded",
        noDoubleEncode: { table: "studio_edits", column: "params" },
        notExercised: true,
      },
    ],
    invariants: [
      "the original asset row is never mutated by an edit",
      "every studio_assets / studio_edits query is user_id-filtered (zero-trust)",
      "every generative (cloud) op is gated by the cloudAI consent toggle",
      "every face-touching generative op passes the identity gate (assertIdentityPreserved)",
      "a retried edit with a committed idempotency_key returns the existing row, never re-charges",
      "an edit only chains onto a parent that is done with an output (no half-built chain)",
      "deviceRender requires client bytes and is free + never consent/identity-gated (WYSIWYG)",
      "a client-supplied mask must resolve to a studio asset owned by the same user",
    ],
  },
  {
    id: "studio-learn",
    summary:
      "Studio learns the user's photo-editing taste from the edits they apply. Each committed editSemantic fires a signal (recordEditSignal); a background pass every few edits distills them (Haiku) into an editable photo-style.md vault note + photo_style user_model entries. It's injected back as personalized recommendations (suggestEdits style block) and a personalized auto-enhance (editSemantic personalize flag -> styleHint in the generative prompt), never overriding an explicit typed edit. Gated by NOMOS_ADAPTIVE_MEMORY; per-user scoped.",
    trigger: { kind: "turn", gate: "studio" },
    entry: ["recordEditSignal", "flushPhotoStyle", "readPhotoStyle"],
    effects: [
      {
        // Exercised by runStudioLearn: 4 edits -> flushPhotoStyle distills the note.
        claim: "learned editing taste is written as an editable photo-style.md vault note",
        sql: {
          query: "SELECT count(*) FROM vault_notes WHERE path = 'photo-style.md'",
          expect: "nonzero",
        },
      },
      {
        claim: "structured photo_style preferences accumulate in the user model",
        sql: {
          query: "SELECT count(*) FROM user_model WHERE category = 'photo_style'",
          expect: "nonzero",
        },
      },
    ],
    invariants: [
      "learning is gated by NOMOS_ADAPTIVE_MEMORY and is per-user scoped",
      "personalization biases auto-enhance + suggestions, never an explicit typed edit",
    ],
  },
  {
    id: "mood-episodes",
    summary:
      "On a turn where the live theory-of-mind flags strain, the agent captures a mood EPISODE (its cause, not a standing state) into an editable mood-log.md vault note; episodes decay (30d/20) and the live read always wins. Open episodes are surfaced so the agent follows up on the CAUSE, never asserts a mood. Forked-Haiku cause-naming, NOMOS_ADAPTIVE_MEMORY-gated, per-user.",
    trigger: { kind: "turn" },
    entry: ["recordMoodEpisode", "captureMoodFromTurn", "readOpenMoodEpisodes"],
    effects: [
      {
        claim: "mood episodes are persisted as an editable mood-log.md vault note",
        sql: {
          query: "SELECT count(*) FROM vault_notes WHERE path = 'mood-log.md'",
          expect: "nonzero",
        },
      },
    ],
    invariants: [
      "per-user scoped (user_id)",
      "episodes-with-causes, not a standing mood; the live read wins; decay applies",
    ],
  },

  // ── Per-turn (memory-indexer) ──
  {
    id: "conversation-memory",
    summary: "Index every non-ephemeral turn into vector memory with provenance.",
    trigger: { kind: "turn" },
    entry: ["indexConversationTurn"],
    effects: [
      {
        claim: "conversation memory_chunks carry metadata.source='conversation' (not empty {})",
        sql: {
          query:
            "SELECT count(*) FROM memory_chunks WHERE source='conversation' AND metadata->>'source'='conversation'",
          expect: "nonzero",
        },
        noDoubleEncode: { table: "memory_chunks", column: "metadata", where: "metadata <> '{}'" },
      },
      {
        claim: "conversation chunks are embedded for semantic recall (not FTS-only)",
        sql: {
          query:
            "SELECT count(*) FROM memory_chunks WHERE source='conversation' AND embedding IS NOT NULL",
          expect: "nonzero",
        },
      },
    ],
    invariants: ["per-owner scoped", "ephemeral sessions skipped"],
  },
  {
    id: "background-tasks",
    summary:
      "Wait-and-resume: the agent registers long async work (CI/deploy/build) via the background_register " +
      "tool; a __background_watch__ cron sentinel polls each task's `watch` command and, on completion, " +
      "enqueues a RESUME turn keyed to the ORIGINAL sessionKey so the agent picks the same conversation back " +
      "up with the result -- no dead-end 'waiting' message and no silent drop. In-process store for " +
      "power-user (lost on restart by design); Redis-backed store + leased watcher in hosted (Phase 2). " +
      "Idempotent: a settled task is marked and excluded from listPending, so it never re-fires.",
    trigger: { kind: "cron", sentinel: "__background_watch__", schedule: "1m" },
    entry: ["runBackgroundWatchSweep", "getBackgroundTaskStore"],
    effects: [
      {
        claim:
          "on settle, the watcher enqueues a resume turn to the task's original sessionKey, and pending/unsettled tasks produce no resume (verified deterministically by src/daemon/background-tasks.test.ts)",
        notExercised: true,
      },
    ],
    invariants: [
      "resume targets the ORIGINAL sessionKey (same conversation), not an isolated cron key",
      "idempotent: a settled task is excluded from listPending, so it never double-resumes",
      "in-process store is lost on daemon restart by design (power-user); hosted uses Redis + a leased watcher",
      "the sweep runs no agent turn except the resume it enqueues; one failed resume doesn't wedge the others",
    ],
  },
  {
    id: "adaptive-memory",
    summary: "Extract knowledge from turns into the user model (opt-in adaptiveMemory).",
    trigger: { kind: "turn", gate: "adaptiveMemory" },
    entry: ["extractAndStoreKnowledge", "updateUserModel"],
    effects: [
      {
        claim: "user_model entries store value as a jsonb object (not a double-encoded string)",
        sql: {
          query: "SELECT count(*) FROM user_model WHERE jsonb_typeof(value) = 'object'",
          expect: "nonzero",
        },
        noDoubleEncode: { table: "user_model", column: "value" },
      },
    ],
    invariants: ["UNIQUE(user_id, category, key)", "no jsonb double-encode"],
  },
  {
    id: "memory-enrichment",
    summary:
      "Write-time retrieval enrichment: when a vault note is indexed, a bounded Haiku fork " +
      "generates paraphrase 'search aliases' (the questions the note answers, in different words) " +
      "that are embedded as extra memory_chunks (metadata.kind='alias') pointing at the SAME note " +
      "path, so semantically phrased queries land on the note. Off the read path (fire-and-forget " +
      "from vaultWrite); idempotent per (user,note) via deterministic alias ids; best-effort, never throws.",
    trigger: { kind: "turn", gate: "memoryEnrichment" },
    entry: ["enrichNoteRetrieval", "generateRetrievalAliases"],
    effects: [
      {
        claim:
          "indexed notes get embedded alias chunks (metadata.kind='alias') pointing at the note path",
        sql: {
          query:
            "SELECT count(*) FROM memory_chunks WHERE metadata->>'kind' = 'alias' AND embedding IS NOT NULL",
          expect: "nonzero",
        },
        noDoubleEncode: {
          table: "memory_chunks",
          column: "metadata",
          where: "metadata->>'kind' = 'alias'",
        },
        notExercised: true,
      },
    ],
    invariants: [
      "per-owner scoped (user_id); alias ids namespaced vault:<hash(userId:path)>:alias:i",
      "gated on memoryEnrichment + embeddings available; best-effort, never throws",
      "idempotent on (user_id, path): deterministic alias ids upsert, never duplicate",
      "forget removes alias chunks via the shared vault:<hash>: prefix",
    ],
  },
  {
    id: "commitment-capture",
    summary: "Extract promises/follow-ups from turns into the commitments table (opt-in).",
    trigger: { kind: "turn", gate: "commitmentTracking" },
    entry: ["extractCommitments", "storeCommitments"],
    effects: [
      {
        claim: "commitments rows are stored with a description + owner",
        sql: { query: "SELECT count(*) FROM commitments", expect: "nonzero" },
      },
      {
        claim:
          "a commitment naming a known contact resolves to a contact_id (not dropped on insert)",
        sql: {
          query: "SELECT count(*) FROM commitments WHERE contact_id IS NOT NULL",
          expect: "nonzero",
        },
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "knowledge-graph-ingest",
    summary: "Promote extracted facts into the bitemporal knowledge graph.",
    trigger: { kind: "turn", gate: "adaptiveMemory" },
    entry: ["ingestKnowledgeIntoGraph", "backfillGraph"],
    effects: [
      {
        claim: "kg_nodes/kg_edges are produced from the vault + contacts",
        sql: { query: "SELECT count(*) FROM kg_nodes", expect: "nonzero" },
      },
      {
        claim: "kg_edges carry attrs as a jsonb object",
        noDoubleEncode: { table: "kg_edges", column: "attrs", where: "attrs <> '{}'" },
      },
    ],
    invariants: ["per-owner scoped, no cross-tenant traversal"],
  },

  // ── Boot ──
  {
    id: "hooks-registry",
    summary: "Load ~/.nomos/hooks.json at startup so PreToolUse blocking is reachable.",
    trigger: { kind: "boot" },
    entry: ["initializeHooks", "buildSdkHooks"],
    effects: [
      {
        claim: "PreToolUse hook denies blocked tools inside the SDK (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "tool-approval-gate",
    summary:
      "Enforce TOOL_APPROVAL_POLICY: a PreToolUse gate blocks dangerous tools the policy won't auto-approve, even under the daemon's bypassPermissions.",
    trigger: { kind: "turn" },
    entry: ["ToolApprovalChecker"],
    effects: [
      {
        claim:
          "block_critical (default) denies critical-severity tools via the SDK PreToolUse deny (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "sdk-runtime-hardening",
    summary:
      "Phase A config wires on the central runSession options/env: A.2 fallbackModel (singular comma-joined string + refusal-fallback eviction via AssistantText), A.3 settingSources:[] + CLAUDE_CODE_DISABLE_AUTO_MEMORY (hermetic runtime, no stray .claude/ leakage), A.4 ENABLE_TOOL_SEARCH=auto (off on custom base URL). Applies to BOTH the one-shot and Layer-A live paths since both flow through runSession.",
    trigger: { kind: "turn" },
    entry: ["runSession", "AssistantText"],
    effects: [
      {
        claim:
          "refusal-fallback retracted/superseded message uuids are evicted from the final turn text (behavioral; unit-tested in assistant-text.test.ts)",
        notExercised: true,
      },
    ],
    invariants: [
      "settingSources:[] unless NOMOS_SETTING_SOURCES=project (no filesystem .claude/ config loads)",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 unless NOMOS_AUTO_MEMORY=1 (auto-memory loads even with settingSources:[])",
      "fallbackModel is a single comma-joined string, never an array",
      "ENABLE_TOOL_SEARCH defaults to auto only when no custom anthropicBaseUrl is set",
    ],
  },
  {
    id: "session-resume-persistence",
    summary:
      "Phase B.2 — persist the SDK session id to sessions.metadata.sdkSessionId after each non-ephemeral daemon turn, so a conversation resumes across a daemon restart (the daemon already READS it on resume; this is the write-back). B.3 routes both drains' result.modelUsage through CostTracker; B.1 caps the main turn at NOMOS_TURN_BUDGET_USD.",
    trigger: { kind: "turn" },
    entry: ["updateSessionSdkId", "accrueModelUsage"],
    effects: [
      {
        claim: "sessions.metadata.sdkSessionId is populated for resumed daemon sessions",
        sql: {
          query:
            "SELECT count(*) FROM sessions WHERE metadata->>'sdkSessionId' IS NOT NULL AND session_key NOT LIKE '%ephemeral%'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: [
      "ephemeral sessions are NOT written back (off-the-record)",
      "write-back is fire-and-forget; a DB failure never blocks the turn",
    ],
  },
  {
    id: "structured-outputs",
    summary:
      "Phase C — the three LLM-JSON forks (knowledge extractor, theory-of-mind, mood capture) pass a zod schema as the SDK `outputFormat` (JSON Schema) and consume `result.structured_output`, replacing the fragile regex + JSON.parse path. The SDK validates + bounded-retries; the existing parser still validates the shape, and the legacy text-parse remains a fallback.",
    trigger: { kind: "turn" },
    entry: ["runForkedAgent", "ExtractedKnowledgeSchema"],
    effects: [
      {
        claim:
          "knowledge extraction still populates memory_chunks (now via structured_output, no silent JSON.parse drop)",
        sql: { query: "SELECT count(*) FROM memory_chunks", expect: "nonzero" },
        notExercised: true,
      },
    ],
    invariants: [
      "outputSchema → JSON Schema via z.toJSONSchema; structured_output preferred, text-parse is the fallback",
      "a malformed/absent structured output degrades to the legacy parse, never throws",
    ],
  },
  {
    id: "turn-safety-and-control",
    summary:
      "Phase D — D.1 scoped Bash(...) deny rules for irrecoverable criticals (defense-in-depth alongside the block_critical hook); D.2 cancellable turns (per-session AbortController for one-shot + Query.interrupt() for the live session, triggered by the gRPC `interrupt:<sessionKey>` command); D.4 forks skip persistSession + enableFileCheckpointing (pure overhead). D.3: PreCompact/PostCompact are real, wired observe-only; per-turn capture already flushes durable memory before compaction.",
    trigger: { kind: "turn" },
    entry: ["interruptSession", "CRITICAL_BASH_DENY"],
    effects: [
      {
        claim:
          "an in-flight turn can be cancelled (subprocess killed / Query.interrupt), and critical Bash patterns are denied declaratively (behavioral)",
        notExercised: true,
      },
    ],
    invariants: [
      "live sessions interrupt via Query.interrupt (session survives); one-shot turns abort via AbortController",
      "scoped Bash deny rules never block legitimate commands (criticals only)",
      "forks run with persistSession:false + enableFileCheckpointing:false",
    ],
  },
  {
    id: "power-user-sandbox",
    summary:
      "Phase E — opt-in OS Bash sandbox (NOMOS_SANDBOX=true) on the main runParams for the power-user box (untrusted channel input + bypassPermissions + no container). Permissive network allowlist (NOMOS_SANDBOX_DOMAINS), failIfUnavailable:false, allowAppleEvents:true. Hosted is skipped (container isolation). The dead REPL /sandbox toggle is now informational; profile.ts no longer advises disabling protection.",
    trigger: { kind: "turn", gate: "powerUser" },
    entry: ["buildSandboxConfig"],
    effects: [
      {
        claim:
          "when NOMOS_SANDBOX=true (power-user), Bash runs under OS filesystem+network confinement (behavioral)",
        notExercised: true,
      },
    ],
    invariants: [
      "off by default; opt-in via NOMOS_SANDBOX; never enabled in hosted mode",
      "scoped permissively so legitimate file/network work still runs; degrades gracefully if unavailable",
    ],
  },
  {
    id: "native-subagents",
    summary:
      "Phase G — team mode now uses the native SDK `agents` path BY DEFAULT (team-worker + read-only verifier; `Agent` in allowedTools). `/team` and natural-language delegation both route to the model's Agent tool inside the normal loop (so ToM + memory + cost tracking apply — the legacy /team early-return bypassed them). Subagents inherit the parent's hooks → block_critical is structural. The hand-rolled TeamRuntime is retained only behind NOMOS_LEGACY_TEAM as a one-release rollback; the physical ~800-LOC deletion is the next-release cleanup. Verified live by eval/grpc-native-team-e2e.ts (agentToolUses>=1).",
    trigger: { kind: "turn", gate: "teamMode" },
    entry: ["buildNativeAgents", "useNativeTeam"],
    effects: [
      {
        claim:
          "with team mode on, the model delegates via the Agent tool to inherited-permission subagents (behavioral; eval/grpc-native-team-e2e.ts proves agentToolUses>=1)",
        notExercised: true,
      },
    ],
    invariants: [
      "native is the default team mechanism; NOMOS_LEGACY_TEAM forces the hand-rolled path",
      "the verifier subagent is read-only (no Write/Edit)",
      "subagents inherit parent permission + hooks (block_critical is structural, not hand-threaded)",
    ],
  },
  {
    id: "wiki-disk-reconcile",
    summary: "Reconcile the on-disk wiki cache with the DB at boot (power-user only).",
    trigger: { kind: "boot" },
    entry: ["reconcileOnStartup"],
    effects: [
      { claim: "mirrors wiki_articles to/from disk at boot (behavioral)", notExercised: true },
    ],
  },
  {
    id: "proactive-jobs",
    summary:
      "Register the proactive cron jobs (inbox scan, calendar/meeting brief, morning briefing).",
    trigger: { kind: "boot" },
    entry: [
      "registerProactiveJobs",
      "inboxScanJobSpec",
      "calendarScanJobSpec",
      "morningBriefingJobSpec",
    ],
    effects: [
      {
        claim: "seeds the proactive cron_jobs into the cron engine (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "autonomous-loops",
    summary:
      "Load bundled LOOP.md definitions (3-tier: bundled/personal/project) and seed them into cron_jobs at boot (disabled by default). The agent authors + manages its OWN loops in-loop via the nomos-loops tools (source='loop' — distinct from a user/assistant 'agent' TASK, so loops show on the Loops surface, not Tasks/Today); the user audits/disables them in Settings.",
    trigger: { kind: "boot" },
    entry: ["seedAutonomousLoops", "loadAllLoops", "buildLoopMcpServer"],
    effects: [
      {
        claim: "the bundled autonomous loops are seeded into cron_jobs by name",
        sql: {
          query:
            "SELECT count(*) FROM cron_jobs WHERE source = 'bundled' AND name IN ('calendar-prep','calendar-upcoming','digital-marketing','email-triage','memory-consolidation','slack-digest')",
          expect: "nonzero",
        },
      },
      {
        claim: "bundled loops are seeded disabled (opt-in, never auto-fire)",
        sql: {
          query: "SELECT count(*) FROM cron_jobs WHERE source = 'bundled' AND enabled = true",
          expect: "zero",
        },
      },
    ],
    invariants: [
      "seeded idempotently (INSERT ON CONFLICT (name) DO NOTHING)",
      "bundled loops ship enabled:false; only the user or the agent enables them",
      "agent-created loops carry source='loop' + the owner's user_id (auditable + per-owner scoped; excluded from Tasks/Today, surfaced on Loops)",
    ],
  },
  {
    id: "managed-loop-override",
    summary:
      "Consumer Loops audit + control surface (MobileApi.ListLoops/SetLoopEnabled). The hosted user owns none of the instance's `system`-owned background loops, so ListLoops also surfaces a curated managed set (auto-dream -> 'Brain consolidation', style-analyze -> 'Writing style learning') under friendly labels. Toggling one writes a per-user app.userLoop.<name>.enabled config override (setLoopUserEnabled) instead of mutating the shared system row; cron-engine honors it at fire time as an AND-gate (isLoopUserDisabled).",
    trigger: { kind: "turn" },
    entry: [
      "curateConsumerLoops",
      "isLoopUserDisabled",
      "setLoopUserEnabled",
      "userLoopOverrideKey",
    ],
    effects: [
      {
        claim: "toggling a managed loop persists app.userLoop.<name>.enabled in the config table",
        sql: {
          query: "SELECT count(*) FROM config WHERE key LIKE 'app.userLoop.%'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: [
      "managed loops display friendly labels but toggle/delete key off the real job name",
      "AND-gate: a managed loop fires only if its system row is enabled AND the user has not opted out",
      "the shared system cron_jobs row is never mutated per-user (per-customer DB scoping)",
      "infra plumbing (wiki/graph/magic-docs/delta-sync) + the proactive family are hidden from the consumer surface",
    ],
  },

  // ── Wired runtime helpers (dormant-prone) ──
  {
    id: "memory-digest",
    summary: "Inject a reasoning-first user-model + profile digest into every turn.",
    trigger: { kind: "turn" },
    entry: ["buildMemoryDigest"],
    effects: [
      {
        claim: "the digest is appended to systemPromptAppend each turn (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "wiki-reader",
    summary: "Surface query-relevant wiki articles into the turn prompt.",
    trigger: { kind: "turn" },
    entry: ["getRelevantArticles"],
    effects: [
      {
        claim: "owner-scoped FTS over wiki injected into the prompt (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "sdk-robustness",
    summary: "Forked-agent retry, prompt-cache-break detection, tool-result dedup.",
    trigger: { kind: "turn" },
    entry: ["withRetry", "getPromptCacheTracker", "getToolResultStore"],
    effects: [
      {
        claim: "transient 429/529 forks retry; opt-in dedup + cache-break logging (behavioral)",
        notExercised: true,
      },
    ],
  },

  // ── Completeness pass: more wired features that produce durable state ──
  {
    id: "transcript-append",
    summary: "Persist each non-ephemeral turn's user + assistant messages with token usage.",
    trigger: { kind: "turn" },
    entry: ["appendTranscriptMessage"],
    effects: [
      {
        claim: "transcript_messages store user + assistant turns",
        sql: {
          query: "SELECT count(*) FROM transcript_messages WHERE role IN ('user','assistant')",
          expect: "nonzero",
        },
      },
      {
        claim: "per-message token usage round-trips as a jsonb object (not double-encoded)",
        noDoubleEncode: {
          table: "transcript_messages",
          column: "usage",
          where: "usage IS NOT NULL",
        },
      },
    ],
    invariants: ["ephemeral sessions skipped"],
  },
  {
    id: "session-cost-tracking",
    summary: "Accumulate per-session token + USD cost on the sessions row after each turn.",
    trigger: { kind: "turn" },
    entry: ["updateSessionCost"],
    effects: [
      {
        claim: "sessions accumulate total_cost_usd + token counts",
        sql: { query: "SELECT count(*) FROM sessions WHERE total_cost_usd > 0", expect: "nonzero" },
      },
    ],
  },
  {
    id: "exemplar-scoring",
    summary: "Score + store high-quality turns as few-shot exemplars for voice priming.",
    trigger: { kind: "turn", gate: "styleMatching" },
    entry: ["scoreAndStoreExemplar"],
    effects: [
      {
        claim: "exemplar memory_chunks are tagged metadata.exemplar=true",
        sql: {
          query: "SELECT count(*) FROM memory_chunks WHERE metadata->>'exemplar'='true'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "memory-access-decay",
    summary: "Record access_count + last_accessed_at on retrieved chunks for decay scoring.",
    trigger: { kind: "turn" },
    entry: ["recordMemoryAccess"],
    effects: [
      {
        claim: "retrieved memory_chunks have access_count incremented",
        sql: {
          query: "SELECT count(*) FROM memory_chunks WHERE access_count > 0",
          expect: "nonzero",
        },
      },
      {
        claim: "retrieved memory_chunks stamp last_accessed_at",
        sql: {
          query: "SELECT count(*) FROM memory_chunks WHERE last_accessed_at IS NOT NULL",
          expect: "nonzero",
        },
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "contact-crud",
    summary: "Create/link/merge identity-graph contacts across channels.",
    trigger: { kind: "cli", command: "nomos contacts" },
    entry: ["createContact", "linkIdentity", "mergeContacts"],
    effects: [
      {
        claim: "contacts + cross-channel identities are stored",
        sql: { query: "SELECT count(*) FROM contacts", expect: "nonzero" },
      },
      {
        claim: "contact_identities.metadata is a jsonb object (not double-encoded)",
        noDoubleEncode: {
          table: "contact_identities",
          column: "metadata",
          where: "metadata <> '{}'",
        },
      },
    ],
    invariants: ["per-owner scoped (UNIQUE user_id, platform, platform_user_id)"],
  },
  {
    id: "relationship-enrichment",
    summary:
      "Enrich a contact on resolution (role from job title, relationship interaction stats) + derive frequency from ingested history.",
    trigger: { kind: "turn" },
    entry: ["enrichContactRelationship", "computeRelationshipStats", "refreshRelationshipStats"],
    effects: [
      {
        claim: "an inbound job title lands on contacts.role",
        sql: { query: "SELECT count(*) FROM contacts WHERE role IS NOT NULL", expect: "nonzero" },
      },
      {
        claim: "contacts.relationship is enriched with interaction stats (not the default '{}')",
        sql: {
          query: "SELECT count(*) FROM contacts WHERE relationship <> '{}'",
          expect: "nonzero",
        },
      },
      {
        claim:
          "contacts.relationship merges as a jsonb object (never an array/string from a double-encode)",
        sql: {
          query:
            "SELECT count(*) FROM contacts WHERE relationship <> '{}' AND jsonb_typeof(relationship) <> 'object'",
          expect: "zero",
        },
      },
    ],
    invariants: ["per-owner scoped"],
  },
  {
    id: "ingestion-pipeline",
    summary: "Import historical channel conversations into vector memory with dedup.",
    trigger: { kind: "cli", command: "nomos ingest" },
    entry: ["runIngestionPipeline"],
    effects: [
      {
        claim: "ingested chunks are stored with source='ingest'",
        sql: {
          query: "SELECT count(*) FROM memory_chunks WHERE source='ingest'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: ["per-owner scoped", "hash dedup avoids re-indexing"],
  },
  {
    id: "cate-inbound-queue",
    summary: "Queue inbound agent-to-agent (CATE) requests for owner approval.",
    trigger: { kind: "turn" },
    entry: ["enqueueInbound"],
    effects: [
      {
        claim: "cate_inbound rows carry a status + trust_tier workflow",
        sql: { query: "SELECT count(*) FROM cate_inbound", expect: "nonzero" },
        notExercised: true,
      },
    ],
  },

  // ── Session management ──
  {
    id: "session-continuity",
    summary: "Create + resume SDK sessions by stable key; durable state survives session rotation.",
    trigger: { kind: "turn" },
    entry: ["createSession", "getSessionByKey"],
    effects: [
      {
        claim: "sessions persist under a stable session_key",
        sql: {
          query: "SELECT count(*) FROM sessions WHERE session_key IS NOT NULL",
          expect: "nonzero",
        },
      },
      {
        claim: "session metadata (incl. sdkSessionId) round-trips as a jsonb object",
        sql: {
          query: "SELECT count(*) FROM sessions WHERE metadata->>'sdkSessionId' IS NOT NULL",
          expect: "nonzero",
        },
        noDoubleEncode: { table: "sessions", column: "metadata", where: "metadata IS NOT NULL" },
      },
    ],
    invariants: ["stable key default cli:default enables auto-resume"],
  },
  {
    id: "ephemeral-sessions",
    summary:
      "Off-the-record sessions (an 'ephemeral' key segment) skip automatic memory + transcript capture.",
    trigger: { kind: "turn" },
    entry: ["isEphemeralSession"],
    effects: [
      {
        claim: "ephemeral turns are NOT indexed into memory_chunks or transcripts (behavioral)",
        notExercised: true,
      },
    ],
    invariants: ["ephemeral sessions skip the automatic capture path"],
  },
  {
    id: "smart-routing",
    summary:
      "Complexity-based model routing: classify the query, persist the routed tier on the session.",
    trigger: { kind: "turn", gate: "smartRouting" },
    entry: ["classifyQuery", "updateSessionModelByKey"],
    effects: [
      {
        claim: "routed model tier is written to sessions.model (behavioral; off by default)",
        notExercised: true,
      },
    ],
  },

  // ── Multi-agent teams ──
  {
    id: "multi-agent-teams",
    summary:
      "Coordinator/worker orchestration: a coordinator decomposes a task into parallel workers and synthesizes one result. Triggered EITHER by the `/team` prefix (fast path) OR by the in-loop `delegate_to_team` tool (buildTeamMcpServer) the agent calls when the user asks in natural language ('research X from three angles', 'spin up a team') — both work in hosted + power-user modes (both converge on AgentRuntime.runAgent). Gated on teamMode. Workers receive only the BASE mcp set (no nomos-team), so they can never recurse into delegation.",
    trigger: { kind: "turn", gate: "teamMode" },
    entry: ["stripTeamPrefix", "TeamRuntime", "buildTeamMcpServer"],
    effects: [
      {
        claim: "spawns parallel workers + synthesizes (transient, no durable DB state)",
        notExercised: true,
      },
    ],
    invariants: [
      "invokable without the /team prefix via delegate_to_team, in both hosted + power-user modes",
      "workers get only the base mcp set, so a worker can never spawn a nested team",
      "coordinator/worker/verifier runs inherit the block_critical PreToolUse gate (buildSdkHooks in runSingleAgent) — workers run bypassPermissions and must NOT be ungated",
    ],
  },

  // ── Self-improvement (the learning loop) ──
  {
    id: "value-reflection-ranking",
    summary: "Auto-dream reflects on user values + decisions, then re-ranks them by confidence.",
    trigger: { kind: "cron", sentinel: "__auto_dream__", schedule: "6h", fanOut: true },
    entry: ["reflectOnValues", "reRankValues"],
    effects: [
      {
        claim: "user_model 'value' entries carry confidence scores",
        sql: {
          query: "SELECT count(*) FROM user_model WHERE category='value' AND confidence > 0",
          expect: "nonzero",
        },
      },
      {
        claim: "user_model.value is a jsonb object (not double-encoded)",
        noDoubleEncode: { table: "user_model", column: "value", where: "category='value'" },
      },
    ],
    invariants: ["per-owner scoped", "confidence-weighted (boost/decay/floor)"],
  },
  {
    id: "stale-preference-decay",
    summary:
      "Decay confidence of user_model entries untouched for >30 days so aged preferences fade.",
    trigger: { kind: "cron", sentinel: "__auto_dream__", schedule: "6h", fanOut: true },
    entry: ["decayUserModelConfidence"],
    effects: [
      {
        claim:
          "entries older than 30d have confidence decayed toward a floor (no fresh rows to assert in-eval)",
        notExercised: true,
      },
    ],
    invariants: ["per-owner scoped", "decays, never deletes"],
  },
  {
    id: "draft-edit-learning",
    summary:
      "Capture user edits to drafts as corrections that update the user model (approveWithEdit -> captureDraftEdit -> updateUserModel). Only an actual edit (edited != original) is captured; a plain approve is not.",
    trigger: { kind: "turn" },
    entry: ["approveWithEdit"],
    effects: [
      {
        // A correction is stored as a fact whose key is `correction_<slug>` and
        // whose value is { text: corrected, original } (see updateUserModel).
        claim: "edits land as user_model corrections (category='fact', key LIKE 'correction_%')",
        sql: {
          query:
            "SELECT count(*) FROM user_model WHERE category = 'fact' AND key LIKE 'correction_%'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: [
      "per-owner scoped",
      "only an actual edit is learned (plain approve writes no correction)",
    ],
  },
  {
    id: "shadow-observer",
    summary:
      "Passive behavioral observation (tool use, corrections) distilled into the user model (opt-in NOMOS_SHADOW_MODE).",
    trigger: { kind: "turn", gate: "shadowMode" },
    entry: ["ShadowObserver", "recordToolUse"],
    effects: [
      {
        claim: "observations distill into user_model 'behavior' entries (opt-in; off by default)",
        notExercised: true,
      },
    ],
  },

  // ── Theory of mind ──
  {
    id: "theory-of-mind",
    summary:
      "Per-session user mental-state tracker (rule-based each turn + LLM every 3); injected as 'Current User State'.",
    trigger: { kind: "turn" },
    entry: ["TheoryOfMindTracker"],
    effects: [
      {
        claim: "state injected into systemPromptAppend (transient, session-scoped, no DB)",
        notExercised: true,
      },
    ],
  },

  // ── Personalization + identity + extensions ──
  {
    id: "persona-switching",
    summary: "Contextual persona detection + system-prompt injection for multi-role identity.",
    trigger: { kind: "turn" },
    entry: ["detectPersona", "buildPersonaPrompt"],
    effects: [
      {
        claim: "matching persona instructions injected into the prompt (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "auto-linker",
    summary: "Heuristic cross-channel identity resolution + auto-merge of duplicate contacts.",
    trigger: { kind: "cli", command: "nomos contacts link" },
    entry: ["runAutoLinker", "findLinkCandidates"],
    effects: [
      {
        claim: "merges duplicate contacts via the identity graph (behavioral)",
        notExercised: true,
      },
    ],
  },
  {
    id: "plugins",
    summary:
      "Claude marketplace plugins; default set auto-installed on first boot, passed to every query.",
    trigger: { kind: "boot" },
    entry: ["ensureDefaultPlugins", "loadInstalledPlugins", "toSdkPluginConfigs"],
    effects: [
      {
        claim:
          "plugin configs are passed to every SDK query (behavioral; state in ~/.nomos/plugins)",
        notExercised: true,
      },
    ],
  },
  {
    id: "consumer-advanced-surface",
    summary:
      "Hosted Advanced curation (MobileApi.ListSkills/ToggleSkill/ListPlugins). ListSkills filters the full skill catalog to consumer-facing skills (operator-curated external Google skills + an allowlist of bundled consumer skills like pdf/xlsx/weather), under friendly labels, with each skill's persisted on/off folded in (skill.<name>.enabled). ToggleSkill resolves the friendly label back to the raw name (resolveSkillName) before persisting. ListPlugins returns a curated read-only built-in tool set instead of the developer marketplace plugins.",
    trigger: { kind: "turn" },
    entry: ["curateConsumerSkills", "resolveSkillName", "isConsumerSkill"],
    effects: [
      {
        claim: "toggling a skill persists skill.<name>.enabled in the config table",
        sql: {
          query: "SELECT count(*) FROM config WHERE key LIKE 'skill.%.enabled'",
          expect: "nonzero",
        },
        notExercised: true,
      },
    ],
    invariants: [
      "consumer skills = external (operator-curated) + an allowlist of bundled consumer skills; dev/internal/channel skills are hidden",
      "skills display friendly labels but the toggle round-trips back to the raw skill name",
      "ListPlugins surfaces the curated built-in tool set (read-only), not the developer marketplace plugins",
    ],
  },
  {
    id: "scheduled-tasks",
    summary:
      "Consumer Tasks surface, served by BOTH NomosAgent.ListTasks/UpdateTask/DeleteTask (grpc-server, local power-user) and MobileApi.ListTasks/UpdateTask/DeleteTask (hosted, auth-gated); GetToday reuses curateConsumerTasks for its task strip. A 'task' is any cron_jobs row the user/assistant scheduled (one-off 'at' reminders + recurring 'every'/'cron' jobs created via schedule_task/loop_create). curateConsumerTasks(jobs) filters out INFRA_SOURCES (source in {system,bundled}) so the instance's always-on system loops + bundled templates never appear on Tasks even in power-user mode, where systemTenant() collapses onto the owner so they share the owner's user_id; sorts enabled-first then alphabetical. toConsumerTask shapes each row + prettifies the schedule. UpdateTask reschedules/renames/edits the instruction/enables; DeleteTask removes one; both assert ownership before mutating.",
    trigger: { kind: "turn" },
    entry: ["curateConsumerTasks", "toConsumerTask"],
    effects: [
      {
        // Exercised by runTasks: a schedule_task-style reminder (source='agent')
        // is created + survives under --audit (KEEP), so the count is nonzero.
        claim:
          "user/assistant-scheduled tasks are stored as owner-scoped cron_jobs (source='agent')",
        sql: {
          query: "SELECT count(*) FROM cron_jobs WHERE source IN ('agent','user')",
          expect: "nonzero",
        },
      },
      {
        // The complement: infra loops genuinely EXIST in cron_jobs (so "Tasks hides
        // them" is a non-vacuous claim); curateConsumerTasks filters them out of the
        // view (asserted by runTasks' check() + the task-view unit test).
        claim:
          "infra loops (system/bundled) exist as cron_jobs but are filtered out of the Tasks view",
        sql: {
          query: "SELECT count(*) FROM cron_jobs WHERE source IN ('system','bundled')",
          expect: "nonzero",
        },
      },
    ],
    invariants: [
      "Tasks are owner-scoped (user_id); system/bundled infra loops are filtered out by INFRA_SOURCES and never appear on this surface, even when they share the owner's user_id in power-user mode",
      "served by both NomosAgent (local) and MobileApi (hosted) ListTasks/UpdateTask/DeleteTask off the same curateConsumerTasks view",
      "UpdateTask/DeleteTask assert job.userId === the resolved owner before mutating",
      "schedule_task stamps source='agent' (a user-owned task, not infra)",
    ],
  },
  {
    id: "ask-user-elicitation",
    summary:
      "MCP-native ask_user round-trip: an in-process tool raises an elicitation/create request; the SDK relays it to AgentRuntime's onElicitation callback (handleElicitation), which renders the question on the user's active channel. Slack gets Block Kit buttons, any text channel matches a numbered/label reply, and channel-less clients (mobile/terminal) get an 'ask' AgentEvent over the open stream via a per-source registered emitter (registerEmitter/unregisterEmitter), with the answer returned OUT-OF-BAND through the AnswerQuestion RPC (NomosAgent + MobileApi) -> resolveById. Answering out-of-band (not as a new chat turn) avoids deadlocking the per-session FIFO queue behind the suspended turn. A pending entry is keyed by elicitation id with a TTL auto-decline.",
    trigger: { kind: "turn" },
    entry: ["handleElicitation", "registerEmitter", "unregisterEmitter", "resolveById"],
    effects: [
      {
        claim:
          "ask_user renders the question on the active channel / over the open stream and resolves the agent's suspended promise from the out-of-band answer (in-memory pending map + transient 'ask' stream event; no durable table)",
        notExercised: true,
      },
    ],
    invariants: [
      "the elicitation manager is created at gateway boot and handed to both the runtime and the gRPC server (setElicitationManager)",
      "AnswerQuestion is served by BOTH NomosAgent (grpc-server) and MobileApi (auth-gated) and both resolve via resolveById",
      "mobile/terminal sources (no channel adapter) register a per-source emitter that pushes an 'ask' AgentEvent and is torn down when the turn ends",
      "the answer arrives out-of-band (a dedicated RPC), never as a new chat message, so the suspended turn never deadlocks the session queue",
    ],
  },
  {
    id: "brain-overview",
    summary:
      "Consumer Brain page (MobileApi.GetBrain). Composes the read model from real per-user memory: the knowledge graph (kg_nodes/kg_edges via getProjection) drives the map + entities, and the accumulated user_model drives the recently-learned facts feed. Owner-scoped via TenantContext.",
    trigger: { kind: "turn" },
    entry: ["getBrainOverview", "getProjection"],
    effects: [
      {
        claim: "the brain map reads nodes from the per-user knowledge graph",
        sql: { query: "SELECT count(*) FROM kg_nodes", expect: "nonzero" },
        notExercised: true,
      },
    ],
    invariants: [
      "owner-scoped: nodes/edges/facts filtered by user_id",
      "facts come from user_model (confidence binned to 0..3); entities/edges from kg_nodes/kg_edges",
    ],
  },
  {
    id: "inbox-overview",
    summary:
      "Consumer Inbox (MobileApi.GetInbox). Two owner-scoped sections: the agent's drafted replies awaiting approval (draft_messages: pending=needs-you, approved/sent=handled) and the CATE agent-to-agent inbound queue (cate_inbound, best-effort). Draft actions reuse ApproveDraft/RejectDraft; CATE via ActOnInboxItem.",
    trigger: { kind: "turn" },
    entry: ["getInboxOverview"],
    effects: [
      {
        claim: "pending drafts awaiting approval are owner-scoped in draft_messages",
        sql: { query: "SELECT count(*) FROM draft_messages", expect: "nonzero" },
        notExercised: true,
      },
    ],
    invariants: [
      "owner-scoped by user_id",
      "drafts + CATE merged read-only; mutations via existing draft/inbox RPCs",
    ],
  },
  {
    id: "today-overview",
    summary:
      "Consumer Today brief (MobileApi.GetToday). Composes today's Google Calendar events (live via gapiFetch, best-effort -- empty when Google isn't connected), pending commitments, and one-off ('at') reminders due by end of today. Recurring tasks ('every'/'cron') are NOT shown here -- they live on the Tasks page, so Today never duplicates them. briefingEnabled=false (proactive autonomy off) tells the client to show the enable-briefing deep link.",
    trigger: { kind: "turn" },
    entry: ["getTodayOverview"],
    effects: [
      {
        claim: "commitments feeding the brief are owner-scoped",
        sql: { query: "SELECT count(*) FROM commitments", expect: "nonzero" },
        notExercised: true,
      },
    ],
    invariants: [
      "owner-scoped",
      "calendar is best-effort (empty when Google isn't connected)",
      "gated on app.inboxAutonomy != 'off'",
    ],
  },

  // ── Consent-aware drafting ──
  {
    id: "draft-messages",
    summary:
      "Consent-aware outgoing-message drafting across all channels (always_ask / auto_approve / notify_only).",
    trigger: { kind: "turn" },
    entry: ["DraftManager", "getConsentMode"],
    effects: [
      {
        claim: "draft_messages rows carry an approval status workflow",
        sql: { query: "SELECT count(*) FROM draft_messages", expect: "nonzero" },
      },
    ],
    invariants: ["per-owner scoped", "default channel (direct agent chat) is exempt"],
  },
  {
    id: "think-like-you-tools",
    summary:
      "Bridge the /reflect, /calibrate, /dna, /twin-test skills to their backends via the nomos-think MCP tools, so they run the documented logic (gap formula, scenario library, DNA budget, fidelity scoring) instead of improvising. See docs/think-like-you.md.",
    trigger: { kind: "mcp-tool", name: "nomos-think" },
    entry: [
      "buildThinkMcpServer",
      "generateReflectionData",
      "analyzeCalibrationGaps",
      "getNextScenario",
      "compileDNA",
      "sampleRealMessages",
      "calculateFidelityScore",
    ],
    effects: [
      {
        claim:
          "reflect/calibrate/dna/twin-test backends run end-to-end via in-loop tools (exercised by runThinkTools/runDocumentPersistence)",
        notExercised: true,
      },
    ],
  },
  {
    id: "personality-documents",
    summary:
      "Personality documents (DNA, shadow observations) + twin-test fidelity scores persist in the DB (wiki pattern), not ~/.nomos files -- the database is the source of truth.",
    trigger: { kind: "turn" },
    entry: [
      "upsertPersonalityDocument",
      "getPersonalityDocument",
      "recordFidelityScore",
      "getFidelityHistory",
    ],
    effects: [
      {
        claim: "personality_documents rows are stored (DNA / shadow observations)",
        sql: { query: "SELECT count(*) FROM personality_documents", expect: "nonzero" },
      },
      {
        claim: "personality_documents.content is a jsonb object (not double-encoded)",
        noDoubleEncode: { table: "personality_documents", column: "content" },
      },
      {
        claim: "twin-test fidelity scores persist for the history trend",
        sql: { query: "SELECT count(*) FROM fidelity_scores", expect: "nonzero" },
      },
    ],
    invariants: ["per-owner scoped (UNIQUE user_id, kind)", "no jsonb double-encode"],
  },
  {
    id: "heartbeat-config",
    summary:
      "Heartbeat (auto-reply) instructions persist in the DB (config key heartbeat.content), migrated from any HEARTBEAT.md file on first read. The REPL reads DB-first.",
    trigger: { kind: "turn" },
    entry: ["getHeartbeat", "setHeartbeat"],
    effects: [
      {
        claim: "heartbeat instructions are stored in the config table (not a file)",
        sql: {
          query: "SELECT count(*) FROM config WHERE key = 'heartbeat.content'",
          expect: "nonzero",
        },
      },
    ],
  },
];
