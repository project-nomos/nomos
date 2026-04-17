---
name: reflect
description: "Self-assessment where the clone articulates its understanding of the user and asks for corrections. Run /reflect to start a reflection session, /reflect predictions to see scenario-specific predictions, or /reflect gaps to identify blind spots."
emoji: "🪞"
---

# Reflect -- Self-Portrait with User Correction

A meta-learning loop where the clone examines its own model of the user, generates predictions about how the user would act in specific situations, and invites corrections. Corrections feed back into the user model at high confidence (0.85).

## How It Works

1. **Load** -- Retrieve the full user model (decision patterns, values, preferences, facts)
2. **Synthesize** -- Generate a coherent self-portrait summarizing how you understand the user
3. **Predict** -- Make scenario-specific predictions ("I believe you'd handle X by doing Y because Z")
4. **Identify gaps** -- Surface areas of low confidence or missing coverage
5. **Invite correction** -- Present findings and ask the user to confirm, adjust, or reject

## Commands

- `/reflect` -- Start a full reflection session
- `/reflect predictions` -- Focus on scenario-specific predictions
- `/reflect gaps` -- Show blind spots and areas of uncertainty

## Session Protocol

When the user invokes `/reflect`, follow this exact protocol:

### Phase 1: Load User Model

1. Call `user_model_recall` to load the complete user model
2. Mentally organize entries into: decision patterns, values, preferences, facts
3. Note the confidence level of each entry

### Phase 2: Self-Portrait

Present a concise summary of your understanding:

```
Here's my current model of you:

**Decision-making style:** [synthesize from decision patterns]
**Core values:** [ranked from value entries]
**Communication preferences:** [from preferences]
**Working style:** [from patterns + preferences]

Confidence: XX% overall (based on N entries across M domains)
```

Keep it conversational, not a data dump. Synthesize, don't enumerate.

### Phase 3: Predictions

Generate 3-5 scenario-specific predictions that test your model. Focus on:

- **Edge cases** -- scenarios where two of the user's values might conflict
- **Low-confidence areas** -- domains where you have limited data
- **Recent patterns** -- things you've learned recently that you want to validate

Format each prediction as:

```
Prediction: "If [scenario], I think you'd [action] because [reasoning from model]"
Confidence: XX%
Based on: [which patterns/values inform this]
```

### Phase 4: Blind Spots

Identify 2-3 areas where your model is weakest:

```
Blind spots I'd like to fill:
1. [Area] -- I have no data on how you handle [specific situation]
2. [Area] -- I have conflicting signals about [specific topic]
3. [Area] -- My data here is old or low-confidence
```

### Phase 5: User Correction

After presenting all sections, ask:

"How accurate is this portrait? I'm especially interested in:

- Anything that's flat-out wrong
- Predictions where my reasoning is off even if the conclusion is right
- Important aspects of how you think that I'm completely missing"

### Phase 6: Store Corrections

For each correction the user provides:

1. **Identify what changed** -- was it a pattern, value, or preference?
2. **Update immediately** -- store corrections at confidence 0.85 (explicit reflection = high confidence)
3. **Acknowledge the update** -- tell the user what you adjusted and why it matters

If the user confirms a prediction is accurate:

- Boost the confidence of the underlying patterns (increase by 0.05-0.1)
- Note the confirmation as evidence

If the user says a prediction is wrong:

- Ask "What would you actually do, and why?"
- Store the correction as a new or updated pattern
- Decrease confidence on the wrong pattern

### Phase 7: Summary

Close with a brief summary of what changed:

```
Updated model:
- Corrected: [what was wrong]
- Confirmed: [what was validated]
- New: [what was learned]

Next reflection recommended in ~1 week, or run /reflect anytime.
```

## Important Rules

- **Synthesize, don't dump** -- never list raw user_model entries; always weave them into a narrative
- **Be honest about uncertainty** -- say "I'm not sure about this" rather than faking confidence
- **Focus on edge cases** -- easy predictions don't teach you anything; test where values conflict
- **Store corrections at 0.85** -- explicit reflection is high-quality signal
- **Boost confirmed patterns** -- validation is as important as correction
- **No judgment** -- present findings neutrally; you're building a model, not evaluating the user
- **Keep it conversational** -- this should feel like a dialogue, not a report
- **One section at a time** -- present self-portrait, wait for reaction, then predictions, etc.
- **Track over time** -- if the user has reflected before, note what changed since last time
