# Stress & Anxiety Support

> Part of the **[Agent Presence & Continuity](./agent-presence-and-continuity.md)**
> iteration. A real companion notices when you're stressed, responds without being
> patronizing, and _remembers how you were feeling next time_ — rather than treating every
> conversation as an emotional blank slate.
>
> Prior art: the IVY (SAT tutor) implementation pioneered these patterns — real-time
> signal detection, a graduated intervention ladder, and mood persistence across sessions.
> This adapts them from a tutoring context to nomos's general life/work companion.

## 0. TL;DR

nomos already **detects** emotional state every turn but **forgets** it the moment the
session ends, never builds it into how it shows up, and never reaches out about it.

| Capability                            | Today                                                                                                                                                                     | The fix                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Detect stress/frustration/overwhelm   | `theory-of-mind.ts` classifies `emotion` (incl. `stressed`/`frustrated`), `cognitiveLoad`, `energy`, `urgency`, `seemsStuck` every turn, injected as "Current User State" | Keep — it's solid                                                                                 |
| Carry _context_ across sessions       | **Gone** — the state is transient (session-scoped, never persisted)                                                                                                       | Persist the **episode + its cause** (not the feeling); recall the stressor, let the live read win |
| Respond supportively, not robotically | No explicit protocol; the agent improvises                                                                                                                                | A graduated support ladder in `SOUL.md` (acknowledge → adapt → de-escalate)                       |
| Reach out when you're struggling      | Never                                                                                                                                                                     | A proactive emotional check-in (ties to the proactive loops)                                      |
| Return-after-absence warmth           | Absence isn't surfaced                                                                                                                                                    | Tone scaled by time-away + last mood (ties to the elapsed-time anchor)                            |

The detection is done. The work is **persistence, protocol, and proactivity** — all of
which reuse this iteration's continuity, reach-out, and growth machinery.

## 1. What already exists

`src/memory/theory-of-mind.ts` — a hybrid per-turn user-state model:

- **Rule-based classifier** (zero latency, every turn): urgency markers, explicit emotion,
  message patterns, time of day, session duration.
- **LLM assessment** (background, every N turns): sarcasm, implicit frustration, goal
  shifts, confusion, "stuck vs progressing" trajectory.
- It already emits `emotion: "stressed" | "frustrated" | …`, `cognitiveLoad: high`,
  `energy: low`, `seemsStuck`, plus `responseGuidance`, and injects a **"Current User
  State"** section into the system prompt so the agent can adapt tone in the moment.

> So nomos _reads the room_ well already. What it can't do is **remember** the room, or
> **act** on a sustained pattern.

## 2. The gaps

1. **No continuity of context.** `theory-of-mind` state is explicitly _transient — never
   persisted_ (see the file header), so the agent loses the _thread_ — what was weighing on
   you and whether it recurs. (The goal is **not** to carry the _feeling_ forward: mood is
   volatile, and assuming yesterday's stress today would be presumptuous. It's to remember
   the **cause** and notice **patterns**.) IVY persisted a `session_summaries.mood_indicators`
   array; nomos should persist episodes-with-causes, not a standing mood.
2. **No support protocol.** There's `responseGuidance`, but no asserted, graduated way to
   _respond_ to distress — so it's improvised and inconsistent, and risks being
   patronizing ("let's take a break!" on the first sigh).
3. **No proactivity.** The agent never reaches out when it has noticed a stretch of stress.
4. **No safety boundary.** Nothing defines where supportive companionship stops and "please
   talk to a professional" begins.

## 3. The plan

### Phase A — Episodic mood + pattern continuity (not mood-as-state) _(implemented)_

> **Shipped** in `src/memory/mood-log.ts` + `src/daemon/agent-runtime.ts`. Episodes
> (`date · emotion · cause · status`) live in an editable `mood-log.md` vault note;
> `captureMoodFromTurn()` writes one (forked-Haiku names the _cause_) only when the live
> theory-of-mind flags real strain; episodes decay (30d / 20-cap); open episodes are surfaced
> as `## Recently weighing on them` so the agent follows up on the cause, never asserts a mood.
> `NOMOS_ADAPTIVE_MEMORY`-gated, per-user, guarded by the `mood-episodes` manifest entry +
> `runMoodLog` eval. The four rules below are enforced by construction.

Mood is volatile, context-bound, and decaying — **not** a durable fact. So don't persist
"you are stressed" and carry it forward. Persist the **episode and its cause**, and let the
live read win.

At session end, only when `theory-of-mind` flagged genuine strain, write a compact,
timestamped, per-owner **episode** (the agent's read, not the transcript) to the user's
vault (`mood-log.md`, user-editable) and/or an `emotional_context` row:

```
{ date, emotion: "stretched", likely_cause: "Q3 launch", status: "open" | "resolved" }
```

Four rules keep it honest (and not creepy):

- **Live read is primary.** The per-turn `theory-of-mind` is the source of truth for the
  current session; a persisted episode **never** overrides how you actually seem today. If
  you show up fine, you're fine.
- **Recall the cause, not the feeling.** Next session the agent may follow up on the
  _stressor_ — _"how'd the launch land?"_ (welcome) — never assert the mood — _"you seem
  stressed"_ (presumptuous). When the cause resolves, the episode flips to `resolved` and
  drops out of context.
- **Decay.** A day-old episode is a faint prior; a week-old one is near-irrelevant. Weight
  recency and let stale episodes fall off rather than haunt every greeting.
- **Episode ≠ trait.** One hard day is an episode — recall its context, don't generalize. A
  _recurring_ signal (every Monday, every release, every time topic X comes up) is the only
  thing that generalizes: it graduates to a learned pattern in the `user_model` (Phase E).

This is the emotional analogue of the [continuity journal](./agent-presence-and-continuity.md);
`user_id`-scoped, editable, never hidden.

### Phase B — A graduated support protocol in the self-model _(implemented)_

> **Shipped** in the always-on **Agent Nature** block (`src/config/profile.ts`,
> `buildSystemPromptAppend`) under "You attune" — injected unconditionally so it survives a
> custom `SOUL.md`. The ladder below (acknowledge → adapt → de-escalate only when sustained →
> normalize) is the prompt text, bounded by the explicit "companion, not a therapist or crisis
> service" safety line and asserted by `profile.test.ts`.

Add to the system prompt a non-patronizing ladder (adapted from IVY's
mild→moderate→high tiers) for the _companion_ context:

- **Acknowledge** the feeling first, without judgment or toxic positivity.
- **Adapt**: when cognitive load is high, shrink scope — offer the next single step, not the
  whole plan. When stuck, switch approach or zoom out to "what actually matters here."
- **De-escalate** only when the pattern is sustained (3+ signals), not on the first one —
  "want to step back and look at this together?" beats a reflexive "take a break."
- **Normalize**: struggle and stress are normal; reflect progress and effort, grounded in
  real evidence from memory ("you've shipped three hard things this week").

### Phase C — Proactive emotional check-in _(not yet built)_

> **Status:** the data + in-context half is already live (open episodes from Phase A are
> surfaced into the prompt, so the agent follows up on the cause the next time you talk). What
> remains is the **autonomous trigger** — a loop that reaches out via `proactive_send` /
> `loop_create` when an episode is still `open` or a recurring pattern is due. Not yet wired;
> it slots onto [Phase 2 proactive](./agent-presence-and-continuity.md#phase-2--turn-proactive-on-by-default-safely)
> when built.

Trigger on a **cause or a pattern**, never a stale emotional label. The agent may **reach
out** via `proactive_send` / `loop_create` when either (a) an episode is still `open` — a
known stressor it hasn't heard resolved — or (b) a **recurring** stress pattern is due. And
it asks about the _thing_, not the feeling: _"The launch was eating at you Friday — did it
land OK?"_ — never _"you seemed stressed, are you okay?"_ off a one-off. Strictly
opt-out-able, rate-limited (never nagging), only when a notification channel is configured,
and it backs off the instant you signal you're fine. The emotionally-aware case of
[Phase 2 proactive](./agent-presence-and-continuity.md#phase-2--turn-proactive-on-by-default-safely).

### Phase D — Return-after-absence warmth _(small — reuses the elapsed-time anchor)_

Scale the welcome to time-away **and** last mood (IVY's absence ladder): a quick pick-up
after a day; a warmer, lighter re-entry after weeks or after a hard last session — _"Welcome
back — no pressure, we can ease in."_ Uses the [elapsed-time anchor](./agent-presence-and-continuity.md#phase-3--continuity-depth-small--medium).

### Phase E — Learn what helps _(medium — ties to growth)_

Track which responses actually de-escalated this person (IVY's `strategy_effectiveness`):
confidence-weight "when stressed, they want the next concrete step, not reassurance" into
the `user_model`, so support gets _more_ tailored over time rather than re-discovered each
time. Folds into [Phase 4 growth](./agent-presence-and-continuity.md#phase-4--shared-experience-the-genuine-new-capability).

## 4. Safety boundary (non-negotiable)

This is **supportive companionship, not therapy or crisis care.** The agent must:

- Never diagnose, never claim clinical authority, never replace professional help.
- Recognize signals of serious distress (self-harm, hopelessness, acute crisis) and respond
  by **gently encouraging real-world / professional support and surfacing crisis resources**
  (e.g. a hotline), not by trying to "handle" it.
- Stay in its lane: a caring, attentive companion that lightens load and notices patterns —
  explicitly bounded, and that boundary stated in `SOUL.md`.

## 5. Privacy

Emotional context is the most sensitive data nomos holds. Therefore: it lives in the
**user-editable vault** (the owner can read/correct/delete the mood log), it's strictly
`user_id`-scoped like all per-user stores, proactive check-ins are opt-out, and nothing
emotional is shared across owners or surfaced outside the owner's own session. Each durable
store added here gets an `eval/feature-manifest.ts` entry so it can't ship dormant.

## 6. Mapping to the iteration

| Stress/anxiety phase                   | Reuses                                     |
| -------------------------------------- | ------------------------------------------ |
| A — episodic mood + pattern continuity | Continuity (vault + digest, agent journal) |
| C — proactive check-in                 | Reach-out (proactive loops)                |
| D — return warmth                      | Continuity (elapsed-time anchor)           |
| E — learn what helps                   | Growth (user_model + consolidation)        |

So stress & anxiety support isn't a bolt-on module — it's the **emotional layer** of the
same persistent, proactive, growing companion this iteration is building.
