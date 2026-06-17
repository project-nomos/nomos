# Stress & Anxiety Support

> Feature reference. The emotional layer of
> **[Agent Presence & Continuity](./agent-presence-and-continuity.md)**: nomos notices when
> the user is under strain, persists it as an episode with a cause (not a standing mood),
> surfaces it next time so the agent can follow up, and responds with a graduated, bounded
> support protocol.
>
> The patterns are adapted from the IVY (SAT tutor) implementation: live signal detection, a
> graduated intervention ladder, and mood persistence across sessions, moved from a tutoring
> context to nomos's general life/work companion.

## Overview

nomos already reads emotional state every turn, but that read was transient: it shaped the
current reply and was forgotten at session end. This feature gives the read a memory and a
protocol. The design principle throughout is that **mood is not a durable fact**. The agent
persists the _episode and its cause_, lets the _live read win_, and never carries yesterday's
feeling forward as today's truth.

The pipeline is: **detect** (live) -> **capture** (when there is genuine strain) ->
**store** (an editable episode) -> **recall** (surface open episodes) -> **respond** (the
support ladder). Everything is `NOMOS_ADAPTIVE_MEMORY`-gated, `user_id`-scoped, and stored in
the user-editable vault.

## 1. Detect (live, every turn)

`src/memory/theory-of-mind.ts` is a hybrid per-turn user-state model: a zero-latency
rule-based classifier every turn, plus a background LLM assessment every few turns for
sarcasm, implicit frustration, and trajectory. It injects a **"Current User State"** section
into the prompt so the agent can adapt tone in the moment.

The classifier emits one of five signals: `neutral`, `positive`, `frustrated`, `stressed`,
`excited`. Two of those (`stressed`, `frustrated`) count as strain and are what gate capture
below.

## 2. Capture (only on genuine strain)

When the live read is `stressed` or `frustrated`, `agent-runtime.ts` fires
`captureMoodFromTurn(...)` fire-and-forget (it never blocks the reply):

```ts
if (tomState.emotion === "stressed" || tomState.emotion === "frustrated") {
  void captureMoodFromTurn(
    resolveMemoryUserId(message.userId),
    message.content,
    tomState.summary,
  ).catch(() => {});
}
```

`captureMoodFromTurn` (`src/memory/mood-log.ts`) is `NOMOS_ADAPTIVE_MEMORY`-gated. It runs a
forked Haiku subagent (model `NOMOS_EXTRACTION_MODEL`, default `claude-haiku-4-5`) over the
user message (sliced to 1200 chars) plus the theory-of-mind summary, with this distiller
prompt:

> You read one exchange between a user and their AI companion, plus a coarse emotion signal.
> If — and only if — the user shows genuine strain (stress, frustration, overwhelm, anxiety,
> low energy), name WHAT it is about in a few words (the cause/thread, e.g. "the Q3 launch",
> "their manager", "the migration bug"). Do NOT invent strain that isn't there.
>
> Output ONLY JSON: {"strain": true|false, "emotion": "stressed|frustrated|overwhelmed|anxious|low-energy", "cause": "<a few words>"}. If no real strain, {"strain": false}.

`parseMoodCapture` is tolerant of fenced output and records an episode only when
`strain === true` and both `emotion` and `cause` are strings (emotion trimmed to 40 chars,
cause to 120). If the distiller says there is no real strain, nothing is written. So capture
is doubly conservative: the live classifier must flag strain, _and_ the distiller must
confirm a nameable cause.

> **Note.** Capture is **per turn**, not at session end. The live classifier only ever fires
> capture on `stressed`/`frustrated`; the broader list in the distiller prompt
> (`overwhelmed`/`anxious`/`low-energy`) describes what the distiller may _name_, not what
> triggers capture.

## 3. Store (episodes with a cause)

Episodes live in the editable `mood-log.md` vault note (title "Mood log"). Each is:

```ts
interface MoodEpisode {
  date: string;
  emotion: string;
  cause: string;
  status: "open" | "resolved";
}
```

rendered one per line as `- <date> · <emotion> · <cause> · <status>` (fields joined by a
space-padded middle dot), for example:

```
- 2026-06-10 · stressed · Q3 launch · open
```

under the note header:

> # Mood log
>
> Episodes (not a standing state) — what was weighing on you and whether it recurs.

`recordMoodEpisode` **upserts by cause**: it matches on the lowercased cause, and if an
episode for that cause exists it refreshes the date and emotion in place; otherwise it
appends a new `open` episode. So a recurring stressor stays one evolving line rather than
piling up duplicates. It is gated on adaptive memory and no-ops on an empty emotion or cause.

## 4. Recall (surface open episodes)

`readOpenMoodEpisodes` returns the `open` episodes after decay. `agent-runtime.ts` injects up
to five of them into the prompt, after the live "Current User State", under:

> ## Recently weighing on them
>
> Things the user was stretched about lately. You MAY gently follow up on the cause ("how'd
> the launch land?") — never assert their current mood. The live read above wins: if they
> seem fine now, they're fine.

Each line is rendered as `- <cause> (seemed <emotion>, <date>)`: the cause and an _attributed,
dated_ read, never a bare "you are stressed".

## 5. Respond (the support ladder)

The graduated, non-patronizing protocol lives in the always-on **"You attune"** bullet of the
Agent Nature block (`src/config/profile.ts`, injected unconditionally so it survives a custom
`SOUL.md`):

> - **You attune.** You notice how the user is doing (see "Current User State" and "Recently
>   weighing on them" when present) and respond with care, not formula: **acknowledge** the
>   feeling first, without toxic positivity; **adapt** — when their load is high, shrink scope
>   to the next single step, not the whole plan; **de-escalate** only when strain is sustained
>   (don't reflexively say "take a break" at the first sigh); **normalize** struggle and
>   reflect real progress ("you've shipped three hard things this week"). Follow up on the
>   _cause_ they were stretched about — never assert their current mood; if they seem fine
>   now, they're fine. But you are a companion, not a therapist or crisis service: at any
>   sign of serious distress, gently point to real-world and professional support (and crisis
>   resources) rather than trying to handle it yourself.

`profile.test.ts` anchors this by asserting the prompt contains `You attune` and
`not a therapist` (the heading and the safety boundary). The fuller ladder wording is not
separately asserted.

## The four rules (and how strongly each is enforced)

Mood persistence is easy to get wrong (creepy, presumptuous, or stale). Four rules keep it
honest; here is how each is actually enforced in code, not just stated:

1. **Live read is primary.** _Enforced by construction._ The `## Recently weighing on them`
   block is injected _after_ the live "Current User State", and its own text says "The live
   read above wins". A persisted episode never overrides how the user seems today.
2. **Recall the cause, not the feeling.** _Enforced for recall._ The injected line format is
   `- <cause> (seemed <emotion>, <date>)` and the heading instructs the agent to follow up on
   the cause and never assert a mood. The _resolution_ half (flipping an episode to
   `resolved` when the stressor passes) is **partially built**: `recordMoodEpisode` accepts a
   status, but the production capture path never sets it, so episodes stay `open` and there is
   no automatic resolution yet. They age out via decay rather than being marked resolved.
3. **Decay.** _Enforced by construction._ `decay()` drops episodes older than **30 days** and
   caps the log at **20** episodes, applied on both write and read, so stale strain falls off
   instead of haunting every greeting.
4. **Episode is not a trait.** _Half enforced._ One hard day stays a single dated, decaying
   episode, and nothing promotes it to a standing trait. The other half (a _recurring_ signal
   graduating into a learned `user_model` pattern) is not built; capture never writes to
   `user_model`.

## Safety boundary (non-negotiable)

This is supportive companionship, not therapy or crisis care. The boundary is asserted in
every prompt (the closing line of "You attune", above). The agent must not diagnose or claim
clinical authority, should recognize signals of serious distress and respond by gently
encouraging real-world and professional support and surfacing crisis resources rather than
trying to handle it, and should stay in its lane as a caring, attentive companion.

## Privacy

Emotional context is the most sensitive data nomos holds, so it lives in the
**user-editable** vault (`mood-log.md`: the owner can read, correct, or delete it), is
strictly `user_id`-scoped like every per-user store, and is never shared across owners or
surfaced outside the owner's own session. The durable store is declared in
`eval/feature-manifest.ts` so it cannot ship dormant.

## Configuration

| Env var                  | Default            | Effect                                               |
| ------------------------ | ------------------ | ---------------------------------------------------- |
| `NOMOS_ADAPTIVE_MEMORY`  | on                 | Gates capture, storage, and recall of mood episodes. |
| `NOMOS_EXTRACTION_MODEL` | `claude-haiku-4-5` | Model for the forked mood-capture distiller.         |

## Where it lives

| Concern                          | File                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Live detection                   | `src/memory/theory-of-mind.ts`                                                    |
| Episode model, capture, storage  | `src/memory/mood-log.ts`                                                          |
| Capture trigger + recall inject  | `src/daemon/agent-runtime.ts`                                                     |
| Support ladder + safety boundary | `src/config/profile.ts` (`buildSystemPromptAppend`)                               |
| Manifest + eval                  | `eval/feature-manifest.ts` (`mood-episodes`), `eval/agent-eval.ts` (`runMoodLog`) |

## Evals and audit

The feature is declared as `mood-episodes` in `eval/feature-manifest.ts` (trigger `turn`,
entry symbols `recordMoodEpisode`/`captureMoodFromTurn`/`readOpenMoodEpisodes`, effect
`SELECT count(*) FROM vault_notes WHERE path = 'mood-log.md'` expecting nonzero). `runMoodLog`
exercises it deterministically: record an episode, assert the `mood-log.md` note exists,
assert `readOpenMoodEpisodes` surfaces it by cause, and assert a second user with no episode
has none. It runs under `pnpm eval:audit`.

## Status and what is not yet built

Detection, capture, storage, recall, and the support protocol ship. The following extensions
are designed but **not built**:

- **Proactive emotional check-in.** The data and in-context half is live (open episodes are
  surfaced so the agent follows up the next time you talk), but there is no autonomous trigger
  that reaches out via `proactive_send`/`loop_create` when an episode is still open or a
  recurring pattern is due. This would slot onto
  [Phase 2 proactive reach-out](./agent-presence-and-continuity.md#2-reach-out-proactive-agency).
- **Return-after-absence warmth.** The [elapsed-time anchor](./agent-presence-and-continuity.md#3-continuity-depth)
  exists, but nothing combines time-away with the last episode to scale the welcome.
- **Learn what helps.** No mechanism confidence-weights which responses actually de-escalate
  this person into the `user_model`; support does not yet get more tailored over time, and the
  episode-to-pattern graduation (rule 4) is unbuilt.
- **Automatic episode resolution.** Open episodes age out via decay rather than being marked
  `resolved` when the stressor passes (see rule 2).
