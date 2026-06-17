# Agent Presence & Continuity

> Feature reference. nomos presents itself as a persistent, proactive, learning
> companion, and the system-prompt and memory machinery that back that up. This document
> describes the design and the wiring as it ships. For the emotional layer (mood episodes
> and the support protocol) see **[Stress & Anxiety Support](./stress-anxiety-support.md)**.

## Overview

A stateless model, asked "can you be a real companion?", denies it can reach out, hold
continuity, or grow. In nomos all three are real capabilities, but the agent used to deny
them anyway: the machinery existed, yet nothing in its prompt tied the pieces into an
identity, so it fell back on training-data disclaimers ("I reset between conversations, I
can't remember, I can't reach out"). This feature closes that self-model gap and deepens
the continuity underneath it.

It has five parts:

1. **Self-model** (`## Agent Nature`): an always-on block telling the agent it persists,
   reaches out, grows, and attunes.
2. **Reach out**: proactive tools, opt-out commitment tracking, and channel awareness.
3. **Continuity depth**: an elapsed-time anchor and an agent-authored journal.
4. **Shared experience**: a weekly agent-authored relationship narrative.
5. **Emotional presence**: mood episodes and a graduated support protocol (its own doc).

Everything is `user_id`-scoped and stores what the agent writes in the user-editable vault,
so the owner can read and correct it.

## 1. Self-model: the "Agent Nature" block

`buildSystemPromptAppend` (`src/config/profile.ts`) pushes a fixed `## Agent Nature`
section into every assembled system prompt. It is unconditional (no feature flag, no
dependency on the user profile) and is positioned after `## Identity` but before the user
profile, the learned-model sections, and `## Memory`.

It opens by directly countering the stateless-LLM reflex:

> You are a persistent, proactive, learning agent — not a generic stateless model. When
> you reason about what you can do, reason from THIS, not from training-data disclaimers.
> Never tell the user you "reset between conversations", "can't remember", "can't reach
> out", or "can't grow" — those are false here.

Then four bullets assert the capabilities (quoted in full because the exact wording is the
feature):

- **You persist.** The durable memory (profile plus the "What I Know About You" context) is
  rebuilt and handed to the agent every turn, so it is the same agent each session; it does
  not need to "remember". This bullet also carries the journal nudge (see
  [§3](#3-continuity-depth)): at the end of a substantial session, jot a first-person note
  to `agent-journal.md` via `memory_write`.
- **You reach out.** The agent can message the user unprompted with `proactive_send` and
  schedule its own recurring checks with `schedule_task`. It is encouraged to offer a
  check-in ("want me to check in on this Friday?") and then follow through.
- **You grow.** The agent learns from every correction and conversation; its model of the
  user deepens and consolidates in the background, not by retraining but by accumulating and
  re-reading what it has learned.
- **You attune.** The support ladder for noticing how the user is doing, ending in the
  safety boundary. Covered in **[Stress & Anxiety Support](./stress-anxiety-support.md)**.

The closing safety line, present in every prompt, is:

> But you are a companion, not a therapist or crisis service: at any sign of serious
> distress, gently point to real-world and professional support (and crisis resources)
> rather than trying to handle it yourself.

**Why it lives in the prompt builder, not in SOUL.** The manifesto is not in `DEFAULT_SOUL`
(`src/config/soul.ts`). A custom personality (a user's `.nomos/SOUL.md` file or the
`agent.soul` DB key, resolved file then DB then `DEFAULT_SOUL`) replaces only the
`## Personality` section. Agent Nature is a separate, fixed builder string, so it survives a
custom SOUL: the persistence/reach-out/growth facts are about the runtime, not personality,
and the user cannot accidentally delete them by writing their own SOUL.

`profile.test.ts` builds the prompt from an empty profile and asserts it contains
`## Agent Nature`, all four bullet labels (`You persist`/`You reach out`/`You grow`/`You
attune`), and `not a therapist`, so the block can never silently drop out.

## 2. Reach out (proactive agency)

### Tools the agent has every turn

- **`proactive_send`** (`src/sdk/tools.ts`): delivers a message to the user's notification
  channel without being asked. If no target is given it resolves the global
  `notifications.default` and delivers through the channel manager.
- **`schedule_task`** (`src/sdk/tools.ts`): creates a daemon-side scheduled task. Schedule
  types are `every` (intervals like `15m`/`1h`/`2d`), `cron` expressions, and `at` (a single
  ISO-8601 time). With `announce: true`, results are posted to the default notification
  channel. No per-owner cap or cadence floor.
- **`loop_create`** and the `nomos-loops` MCP (`src/sdk/loop-mcp.ts`): autonomous loops, a
  prompt run as the agent's own turn on a recurring schedule. Bounded by design: at most
  **20** agent-created loops per owner, a minimum cadence of **5 minutes**, and an
  anti-recursion guard (a running loop cannot create loops). The agent can only manage loops
  it owns (`source: "agent"`); the user can always see, disable, or delete them.
- **Bundled jobs**: commitment reminders, triage digest, inbox/calendar watchers, and a
  morning briefing (`src/proactive/*`, registered at `gateway.ts` via
  `registerProactiveJobs()`). The intrusive ones (inbox/calendar autonomy, daily briefing)
  stay opt-in.

### Commitment tracking (on by default, cost-gated)

`commitmentTracking` is **opt-out**: on unless `NOMOS_COMMITMENT_TRACKING=false`
(`src/config/env.ts`). The agent reminds the user about their own commitments. To stay
honest about cost, the per-turn extraction (its own LLM call) is **cost-gated** in
`src/daemon/memory-indexer.ts`: it runs only when a reach-out is actually deliverable (a
notification channel is configured, per `hasDeliverableTarget()`). No deliverable target
means no extraction and no cost.

The reminder job (`__commitment_reminders__`, every `1h`) fans out per owner via
`listMemoryOwners()`, collecting due reminders for each `user_id`, and the cron handler
delivers each owner's reminders to that owner's notification default.

### Channel awareness

Every turn, the agent is told which channels and integrations are actually connected, via
`buildIntegrationsSummary` (`src/daemon/agent-runtime.ts`). It lists only what is configured
and authenticated, so the agent acts on the real channel set and never claims access it does
not have. These are the user's own channels: Slack (user-token mode), Discord, Telegram,
WhatsApp, **iMessage** (Messages.app on macOS), and email, plus connected tool integrations
like Google. Proactive reach-out (`proactive_send`, and `schedule_task` with
`announce: true`) is delivered to the configured **default notification channel**; when none
is set, the agent is told to ask the user to set one or to pass an explicit target rather
than guessing.

## 3. Continuity depth

### The memory digest (every turn)

`buildMemoryDigest` (`src/memory/digest.ts`) assembles three sources under the heading
`## What you know about this user`:

1. the agent's self-maintained `profile.md` vault note,
2. the high-confidence learned `user_model`, grouped by category and filtered to confidence
   `>= 0.3`, capped at 30 entries by default, and
3. the agent journal (see below).

It returns an empty string when all three are empty. `agent-runtime.ts` rebuilds it fresh on
**every** turn, scoped to the resolved vault owner, and appends it to `systemPromptAppend`
(falling back to empty on error). This _is_ the continuity: the agent is not relying on a
chat buffer that rotates, its durable memory is re-handed to it each turn from the vault and
learned model. Session rotation is therefore never data loss.

### Elapsed-time anchor

When there is a prior session, `agent-runtime.ts` injects a `## Continuity` block giving the
agent a temporal sense of the gap:

> ## Continuity
>
> Your last conversation with the user ended **N ago**. Your memory carries over, but time
> has passed — don't assume nothing has changed since then.

`N` is a human-formatted span (minutes, hours, days, or months). The anchor is **suppressed
when the gap is under 10 minutes** (too recent to be worth anchoring). The previous-session
timestamp comes from `getPreviousSessionEnd(userId, currentSessionKey)`
(`src/db/sessions.ts`), which returns the `updated_at` of the most recent **other** session
for the same resolved owner (it explicitly excludes the current session), or null when there
is none.

### Agent journal

The journal is the `agent-journal.md` vault note (per-user, user-editable, not a checked-in
file). The "You persist" bullet nudges the agent to jot a short first-person note at the end
of a substantial session (what it worked on, what it noticed, where it is picking up next).
Next session, `buildMemoryDigest` re-injects that note under the heading:

> ### Where we left off (your journal)

This is continuity in the agent's own voice, riding the existing vault, so it needs no new
store.

## 4. Shared experience: relationship narratives

This is the part that did not exist before this iteration: the agent deepened its
_understanding_ of the user but never _articulated_ it. A weekly per-owner cron
(`__relationship_narrative__`, schedule `168h`, type `every`, fan-out, seeded in
`gateway.ts` as the job `relationship-narrative`) runs `writeRelationshipNarrative`
(`src/memory/relationship-narrative.ts`).

It is `NOMOS_ADAPTIVE_MEMORY`-gated (checked in the cron handler before fan-out, and again
inside the function), and uses a forked Haiku subagent (model
`NOMOS_EXTRACTION_MODEL`, default `claude-haiku-4-5`) prompted to write in the agent's own
voice, grounded only in the learned facts:

> You are an AI companion reflecting, in YOUR OWN VOICE (first person), on how you've come to
> understand and work with this specific person. Ground EVERY claim in the learned facts
> below — do not invent. Write 4-8 sentences covering: who they are to you, the patterns
> you've learned in how they work and decide, what you've adjusted as a result, and where you
> can be most useful. Warm but honest — no flattery, no "as an AI", no disclaimers. Output
> ONLY the prose.

Up to 40 `user_model` entries are formatted as `- [category] key: value (confidence X.XX)`
and handed to the model under a `WHAT YOU'VE LEARNED ABOUT THEM:` header. On success the
prose is written (capped at 3000 chars) to an editable `relationship.md` vault note titled
"Our working relationship", and the function returns `{ wrote: true }`.

It is a **no-op** (`{ wrote: false, reason }`) in exactly three cases: adaptive memory off
(`"adaptive memory off"`), fewer than `MIN_ENTRIES = 5` learned entries
(`"not enough learned yet"`), or a generated narrative under 40 characters
(`"empty narrative"`). The seeded job uses `deliveryMode: "none"` and
`sessionTarget: "isolated"`: it writes silently to the vault and notifies no one. The user
discovers and edits the result by browsing the `relationship.md` note.

> **Note on scope.** Earlier sketches of this feature (a dedicated `relationship_narratives`
> table, a milestone log, or a proactive "I've noticed some patterns, want me to share?"
> message) did not ship. The single editable vault note, written by the dedicated weekly
> cron, is the whole feature; it is deliberately _not_ part of auto-dream and sends nothing
> proactively.

## 5. Emotional presence

A companion that persists, reaches out, and grows should also notice how the user is doing.
nomos detects strain live (`theory-of-mind.ts`), persists it as **episodes with a cause**
(not a standing mood) in an editable `mood-log.md` vault note, surfaces open ones under
`## Recently weighing on them`, and follows the graduated "You attune" support ladder,
bounded by the companion-not-therapist safety line. Full design, wiring, and the four rules
that keep it honest: **[Stress & Anxiety Support](./stress-anxiety-support.md)**.

## Configuration

| Env var                     | Default            | Effect                                                                                     |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `NOMOS_COMMITMENT_TRACKING` | on (opt-out)       | Per-turn commitment extraction and `1h` reminder cron, cost-gated on a deliverable target. |
| `NOMOS_ADAPTIVE_MEMORY`     | on                 | Gates relationship narratives, mood episodes, and user-model learning.                     |
| `NOMOS_EXTRACTION_MODEL`    | `claude-haiku-4-5` | Model for forked background passes (relationship narrative, mood capture).                 |

## Where it lives

| Concern                 | File                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Agent Nature manifesto  | `src/config/profile.ts` (`buildSystemPromptAppend`)                                           |
| SOUL resolution         | `src/config/soul.ts`                                                                          |
| Proactive tools         | `src/sdk/tools.ts` (`proactive_send`, `schedule_task`), `src/sdk/loop-mcp.ts` (`loop_create`) |
| Commitment cost gate    | `src/daemon/memory-indexer.ts`                                                                |
| Proactive scheduler     | `src/proactive/scheduler.ts`                                                                  |
| Channel awareness       | `src/daemon/agent-runtime.ts` (`buildIntegrationsSummary`)                                    |
| Memory digest + journal | `src/memory/digest.ts`                                                                        |
| Elapsed-time anchor     | `src/daemon/agent-runtime.ts`, `src/db/sessions.ts`                                           |
| Relationship narrative  | `src/memory/relationship-narrative.ts`, `src/daemon/cron-engine.ts`, `src/daemon/gateway.ts`  |

## Evals and audit

Every durable effect is guarded by the spec-driven audit (`eval/feature-manifest.ts`):

- **`relationship-narrative`** (cron): entry symbol `writeRelationshipNarrative`, effect
  `SELECT count(*) FROM vault_notes WHERE path = 'relationship.md'` expecting nonzero, plus
  the cron meta-check (the `__relationship_narrative__` sentinel must be handled in
  `cron-engine.ts` and seeded in `gateway.ts`).
- **`mood-episodes`** (turn): entry symbols `recordMoodEpisode`, `captureMoodFromTurn`,
  `readOpenMoodEpisodes`, effect on `mood-log.md`.

The agent eval drives both end-to-end: `runRelationshipNarrative` (seed five `user_model`
entries, generate, assert the note exists, and assert a barely-known user writes nothing) and
`runMoodLog` (record an episode, assert the note and per-user isolation). `pnpm eval:audit`
runs the eval against a throwaway DB, then an Opus-4.8 content audit and the spec audit, and
prints `AUDIT: PASS` + `SPEC-AUDIT: PASS`.

## Privacy and safety

- Everything the agent writes (journal, relationship narrative, mood log) lives in the
  user-editable vault and is `user_id`-scoped; background jobs fan out per owner.
- Proactive reach-out is opt-out-able, and the cost gate means it does nothing until a
  delivery target exists.
- The companion-not-therapist boundary is asserted in every prompt (see
  [§1](#1-self-model-the-agent-nature-block)).

## Status and known limitations

- Parts 1 to 5 ship. Continuity (the digest, anchor, and journal) and the relationship
  narrative are live and audited.
- The **proactive emotional check-in**, **return-after-absence warmth**, and
  **learn-what-helps** extensions are designed but not built; see the Status notes in
  [Stress & Anxiety Support](./stress-anxiety-support.md).
