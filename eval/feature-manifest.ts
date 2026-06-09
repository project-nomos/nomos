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
    summary: "Compile the per-owner knowledge wiki from the vault on a schedule.",
    trigger: { kind: "cron", sentinel: "__wiki_compile__", schedule: "1h", fanOut: true },
    entry: ["compileKnowledge"],
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
    ],
    invariants: ["per-owner scoped (user_id)"],
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
    ],
    invariants: ["per-owner scoped", "ephemeral sessions skipped"],
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
    id: "commitment-capture",
    summary: "Extract promises/follow-ups from turns into the commitments table (opt-in).",
    trigger: { kind: "turn", gate: "commitmentTracking" },
    entry: ["extractCommitments", "storeCommitments"],
    effects: [
      {
        claim: "commitments rows are stored with a description + owner",
        sql: { query: "SELECT count(*) FROM commitments", expect: "nonzero" },
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
    summary: "Register the proactive cron jobs (inbox/calendar/briefing/triage/commitments).",
    trigger: { kind: "boot" },
    entry: ["registerProactiveJobs"],
    effects: [{ claim: "seeds the proactive cron_jobs (behavioral)", notExercised: true }],
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
];
