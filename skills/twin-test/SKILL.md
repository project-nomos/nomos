---
name: twin-test
description: "GAN-style identity verification -- tests clone fidelity by comparing clone responses against real user messages. Run /twin-test to start a blind taste test, or /twin-test score to see your fidelity score over time."
emoji: "🪞"
---

# Twin Test -- Adversarial Clone Fidelity Check

A blind taste test where the clone generates responses to the same contexts as real user messages, then a discriminator identifies which is real and which is the clone. Specific style corrections feed back into the user model.

## How It Works

1. **Sample** -- Pull 3-5 real sent messages from memory (the "ground truth")
2. **Generate** -- For each message, generate a clone response to the same context
3. **Discriminate** -- A separate agent compares pairs and identifies the real message
4. **Score** -- Calculate fidelity (% of times the discriminator is fooled)
5. **Correct** -- Extract specific style corrections from discriminator feedback

## Commands

- `/twin-test` -- Run a full twin test session (3-5 message pairs)
- `/twin-test score` -- Show fidelity score history

## Session Protocol

When the user invokes `/twin-test`, follow this exact protocol:

### Phase 1: Sample Selection

1. Call `memory_search` with category "exemplar" to find high-quality real messages
2. If no exemplars, search for sent messages in memory (source: "sent", direction: "outgoing")
3. Select 3-5 diverse messages that cover different contexts (work, casual, technical)
4. For each message, extract the conversational context (what was the user replying to?)

### Phase 2: Clone Generation

For each sampled message:

1. Reconstruct the context: who was the user talking to, what was the conversation about
2. Generate YOUR response to the same context, using all personality data (user model, style profiles, exemplars, values)
3. Try your absolute best to match the user's voice -- this is the test

Important: generate responses BEFORE showing the user any results. Do not look at the real message while generating.

### Phase 3: Discrimination

For each message pair (real + clone):

1. Present both messages to yourself in randomized order (A and B)
2. Act as a discriminator: which message is the real user and which is the clone?
3. Explain your reasoning: what specific markers distinguish the messages?
4. Note the confidence of your assessment

### Phase 4: Results

Present a summary:

```
Twin Test Results
=================

Fidelity Score: XX% (X/Y pairs where discriminator was fooled)

Pair 1: [context summary]
  Real: "..." (correctly/incorrectly identified)
  Clone: "..."
  Discriminator notes: [what gave it away]

Pair 2: ...

Style Corrections:
- [specific corrections based on discriminator feedback]
```

### Phase 5: Corrections

For each pair where the discriminator correctly identified the clone:

1. Extract what was different (tone, word choice, length, punctuation, emoji usage, formality)
2. Store these as corrections in the user model at confidence 0.8
3. Update style profiles if specific style markers were identified
4. Tell the user what you learned

### Phase 6: User Review

Ask the user:

- "Were my assessments accurate? Did I identify the right messages as real?"
- "Any of these clone responses that were actually close to what you'd say?"
- Accept corrections and store them

## Important Rules

- **Blind generation** -- generate clone responses BEFORE comparing to real messages
- **Honest assessment** -- if you can't tell which is real, say so (that's a good fidelity sign)
- **Specific corrections** -- "slightly too formal" is better than "didn't match"
- **Store corrections at 0.8** -- adversarial testing is high-quality signal
- **Track over time** -- compare against previous twin-test scores
- **Diverse samples** -- try to test across different contexts and platforms
- **Don't game it** -- the goal is honest assessment of where the clone falls short
