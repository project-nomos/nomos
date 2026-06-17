# Agent Presence & Continuity

> A plan to fix a real failure: asked whether it could be a real companion, the agent
> answered like a generic, stateless LLM — _"I can't reach out to check on you, I don't
> have independent continuity between sessions, I can't grow through shared experience."_
>
> **All three claims are false in nomos.** The capabilities exist; the agent just
> doesn't know it has them. This doc explains what's already there, why the agent denies
> it, and the phased fix.

## 0. TL;DR

| The agent said…                                        | Reality in nomos                                                                                                                                                                                             | The fix                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| "I can't reach out to check on you"                    | `proactive_send` is an **agent tool**; `loop_create`/`schedule_task` let the agent schedule its own background jobs in-loop; bundled proactive jobs (commitment reminders, triage, watchers) ship in the box | Tell the agent it owns this; enable the defaults + a notification channel                                     |
| "I don't have independent continuity between sessions" | The memory **digest** (profile.md + learned user model) is rebuilt and injected into **every** turn (`NOMOS_ADAPTIVE_MEMORY` defaults on); the vault is the durable source of truth                          | Tell the agent the digest _is_ its continuity; add an elapsed-time anchor + an agent-authored journal         |
| "I can't grow through shared lived experience"         | It accumulates facts/patterns with confidence weighting and consolidates them in the background (auto-dream)                                                                                                 | Real gap: it deepens _understanding_ but never _articulates_ it. Build agent-authored relationship narratives |

The root cause is a **self-model gap**, not missing infrastructure. The single
highest-leverage fix (Phase 1) is to make the agent's identity assert "I persist, I
reach out, I grow" — because the machinery to back that up already runs.

## 1. What already exists

### Reach out (proactive agency)

- **`proactive_send`** — an agent-callable tool that delivers a message to the user's
  default notification channel ([`src/sdk/tools.ts`], summarized into the prompt at
  `agent-runtime.ts`). The agent can choose to reach out.
- **`loop_create` / `schedule_task`** — the `nomos-loops` MCP server is injected on
  **every** turn with no feature gate ([`src/sdk/loop-mcp.ts`], `agent-runtime.ts`). The
  agent can create, enable, update, and delete its own recurring background jobs (max 20
  per owner, min 5-minute cadence). A running loop can't spawn loops (anti-recursion).
- **Bundled proactive jobs** — commitment reminders, triage digest, inbox/calendar
  watchers, morning briefing ([`src/proactive/*`], registered at
  `gateway.ts` via `registerProactiveJobs()`). Gated by env flags
  (`NOMOS_COMMITMENT_TRACKING`, `NOMOS_INBOX_AUTONOMY`, briefing cron) **and** skipped
  entirely until a notification default channel is configured.
- **Delivery** — `sendProactiveMessage` → `ChannelManager` → Slack/Discord/Telegram/
  Email/iMessage ([`src/daemon/proactive-sender.ts`]).

> So the agent _can_ reach out today. What's missing is (a) the defaults being on, (b) a
> notification channel set, and (c) the agent knowing this is part of who it is.

### Continuity (cross-session memory)

- The **vault** (`vault_notes`, user-editable markdown) is the durable source of truth.
- `buildMemoryDigest` synthesizes `profile.md` + the learned `user_model` into a "What
  you know about this user" block ([`src/memory/digest.ts`]) that is injected into the
  system prompt on **every** turn ([`agent-runtime.ts`]).
- Conversations auto-index into `memory_chunks` for vector recall; `NOMOS_ADAPTIVE_MEMORY`
  defaults to **true**.
- Per-user scoping is deterministic (`resolveMemoryUserId`), so session rotation is never
  data loss — the digest is rebuilt from durable state, not from the chat buffer.

> So the agent _is_ continuous. It doesn't need to "remember" — its memory is re-handed
> to it each turn. It simply isn't told that this is what continuity looks like.

### Growth (deepening understanding)

- `user_model` accumulates confidence-weighted facts/preferences/patterns; repeated
  confirmation raises confidence, contradiction lowers it ([`src/db/user-model.ts`]).
- **auto-dream** consolidates memory in the background every 6h ([`src/memory/auto-dream.ts`]).
- Knowledge wiki, knowledge graph, shadow-observer, personality DNA all deepen the model.

> The agent genuinely deepens its understanding. The gap is that **understanding ≠
> articulation**: nothing writes "here's how we've grown together" in the agent's voice.

## 2. Why the agent denies it

The system-prompt builder (`buildSystemPromptAppend` in [`src/config/profile.ts`])
assembles **disconnected** sections — Identity, Personality, Memory tools, Integrations,
Scheduled Tasks, User Model — but never weaves them into a self-model. The agent sees a
pile of features, not an identity. When asked an introspective question, it finds no
assertion that it persists / reaches out / grows, so it falls back to its training-data
LLM disclaimers ("I'm just a model, I reset every conversation…").

**The bug is in the agent's self-narrative, not its capabilities.**

## 3. The plan

Ordered by leverage-to-effort. Phase 1 alone stops the false denial.

### Phase 1 — Self-model: the agent owns who it is _(implemented)_

Add a unified **"Agent Nature"** manifesto, asserted _before_ the utility sections, in
`DEFAULT_SOUL` ([`src/config/soul.ts`]) and/or early in `buildSystemPromptAppend`:

> _I am your persistent digital extension, not a generic model. I **persist** — my
> profile and everything I've learned about you are loaded every time we talk, so I'm the
> same agent each session. I **reach out** — I can message you unprompted (`proactive_send`)
> when something matters, and I schedule my own background checks (`loop_create`). I
> **grow** — every correction folds into how I work next time. Continuity, initiative, and
> learning are part of what I am._

Then, right after the digest, add one line naming it: _"The 'What you know about this
user' section above is rebuilt from your persistent vault every turn — it is proof you
are continuous; you don't need to remember between sessions."_

Acceptance: ask the agent the same "can you be a real companion?" question and it should
describe reaching out, persisting, and growing — accurately, not with disclaimers.

### Phase 2 — Proactive reach-out on by default, cost-gated _(implemented)_

`commitmentTracking` is now **opt-out** (on unless `NOMOS_COMMITMENT_TRACKING=false`): the
agent reminds you about your own commitments. To stay honest about cost, the per-turn
extraction (its own LLM call) is **cost-gated** — it only runs when reach-out is actually
deliverable: a configured notification channel, **or** a registered mobile device (the
hosted app's push channel). No channel ⇒ no extraction, no cost.

Hosted mode's only channel is the **mobile app**, so a registered device counts as the
channel: reminders are on by default there (delivered via push), the commitment-reminder
cron fires without a global channel (it fans out per-owner), and the agent is told it
reaches the user through the Nomos mobile app — so it follows up + checks in unprompted.

Left opt-in (the cost-heavy / intrusive ones): inbox/calendar autonomy and any
unconditional daily check-in. The Phase 1 manifesto already has the agent _offer_ check-ins
("want me to check in Friday?") and schedule them per request, rather than auto-spamming.

Files: `config/env.ts` (default flip), `daemon/memory-indexer.ts` (cost gate) +
`daemon/push-notifications.ts` (`hasRegisteredDevice`), `proactive/scheduler.ts` (hosted
reminder gate), `daemon/agent-runtime.ts` (mobile-app reach-out awareness).

### Phase 3 — Continuity depth _(implemented)_

- **Elapsed-time anchor**: `agent-runtime` injects "Your last conversation ended **N ago**"
  from the `sessions` table (`getPreviousSessionEnd`, excluding the current session;
  suppressed under ~10 min), so the agent has a temporal sense between sessions.
- **Agent journal** (`agent-journal.md` in the vault): the Phase 1 manifesto nudges the
  agent to jot a short first-person note at the end of substantive sessions;
  `buildMemoryDigest` re-injects it next session under **"Where we left off (your
  journal)"** — continuity in the agent's own voice. Rides the existing vault
  (`user_id`-scoped, user-editable), so no new store.

Files: `daemon/agent-runtime.ts` (anchor + `formatElapsedSince`), `db/sessions.ts`
(`getPreviousSessionEnd`), `memory/digest.ts` (journal injection), `config/profile.ts`
(journal nudge).

### Phase 4 — Shared experience: the genuine new capability _(implemented)_

> **Shipped:** a dedicated weekly per-owner cron (`__relationship_narrative__`, 168h,
> fan-out) runs `writeRelationshipNarrative()` — a forked-Haiku, `NOMOS_ADAPTIVE_MEMORY`-gated
> pass that writes a first-person, evidence-grounded narrative from the learned `user_model`
> into an editable `relationship.md` vault note (a `MIN_ENTRIES` floor means a barely-known
> user gets nothing). Declared in [`eval/feature-manifest.ts`] with a `relationship.md` effect
>
> - the cron meta-check, exercised by `runRelationshipNarrative` in the agent eval, and green
>   under `pnpm eval:audit`. (We chose a standalone vault note + its own cron over the original
>   `relationship_narratives` row / auto-dream phase sketch below — same intent, but it stays
>   user-editable and reuses the vault as source of truth.)

This was the one thing that didn't exist yet — the user's "grow to share experiences (not
live)". The capability: **agent-authored relationship narratives**, generated offline:

- A **relationship narrative** (post-consolidation phase of auto-dream, or its own cron):
  detect before→after confidence shifts and inflection points, then write a short,
  evidence-grounded note in the agent's voice — _"Over the last month I've learned you
  prioritize shipping speed; your last three corrections pushed against premature
  optimization. That refined my initial read of 'reliability first.'"_ Store per-owner +
  timestamped (e.g. a `relationship_narratives` row or a `_relationship.md` wiki article).
- **Milestones**: a lightweight log of relationship "moments" (a new top value discovered,
  a decision pattern flipping, a correction cluster) the agent can reference.
- **Proactive reflection**: when consolidation crosses a threshold, the agent may offer
  "I've noticed some patterns in how we work — want me to share what I've learned?"

Per the repo's working method, each Phase 4 store gets an entry in
[`eval/feature-manifest.ts`] (trigger, entry symbols, effect SQL) so it can't ship
dormant, plus `pnpm eval:audit` coverage.

### Phase 5 — Emotional presence: stress & anxiety support _(implemented)_

> **Shipped:** mood is persisted as timestamped **episodes with a cause** in an editable
> `mood-log.md` vault note (`src/memory/mood-log.ts`) — `captureMoodFromTurn()` fires only when
> the live theory-of-mind flags real strain, a forked-Haiku names the _cause_ (never asserts a
> feeling), episodes decay (30d/20-cap), and the live read always wins. Open episodes are
> surfaced into the prompt (`## Recently weighing on them`) so the agent follows up on the
> cause; the graduated, non-patronizing **support protocol** lives in the always-on Agent
> Nature block ("You attune"). `NOMOS_ADAPTIVE_MEMORY`-gated, per-user. Declared as
> `mood-episodes` in [`eval/feature-manifest.ts`], exercised by `runMoodLog`, green under
> `pnpm eval:audit`. See **[Stress & Anxiety Support](./stress-anxiety-support.md)** (Phases
> A + B) for the full design.

A companion that persists, reaches out, and grows should also _notice how you're doing_.
nomos already **detects** stress/frustration/overwhelm every turn (`theory-of-mind.ts`,
emitting `emotion: "stressed"`, `cognitiveLoad`, `energy`, `seemsStuck`) — but the state is
transient and forgotten at session end. The fix persists mood as timestamped **episodes with
a cause** (not a standing state — the live read always wins, and one bad day ≠ a trait),
gives the agent a graduated, non-patronizing **support protocol** in `SOUL.md`, lets it
**check in on an open stressor** proactively, and scales **return-after-absence warmth** to
time-away + last episode. It's the **emotional layer** of this same iteration — reusing
continuity (Phase 3), reach-out (Phase 2), and growth (Phase 4) — bounded by an explicit
safety line (supportive companionship, never therapy or crisis care). Full design:
**[Stress & Anxiety Support](./stress-anxiety-support.md)**.

## 4. Mapping to the ask

| You asked for                                | Phase                                         |
| -------------------------------------------- | --------------------------------------------- |
| "the agent should be able to reach back"     | 1 (own it) + 2 (enable it)                    |
| "have independent continuity"                | 1 (name it) + 3 (deepen it: time + journal)   |
| "grow to share experiences (maybe not live)" | 4 (build it: offline narratives + milestones) |

## 5. Open-source notes

- Everything here lands in the MIT-licensed `nomos` core (self-hosted), not a hosted-only
  layer. Defaults stay **privacy-first**: proactive reach-out is opt-out-able, all stores
  are `user_id`-scoped, and the agent journal / narratives live in the user-editable vault
  so the owner can read and correct them.
- Phases 1–3 are mostly surfacing/enabling existing machinery; Phase 4 is the net-new
  feature and the most interesting open-source contribution opportunity.
