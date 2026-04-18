---
name: calibrate
description: "Interactive calibration session to teach the clone how you think, decide, and prioritize. Run /calibrate to start a session, /calibrate status to see coverage, or /calibrate <domain> to focus on a specific area (e.g., /calibrate prioritization). Use when you want to improve clone fidelity, teach it your values, or help it understand your decision-making style."
emoji: "🧠"
---

# Calibrate -- Teach Your Clone How You Think

Interactive scenario-based calibration sessions that extract your decision heuristics, values, and reasoning patterns. Each session takes 5-10 minutes and significantly improves how well the clone models your thinking.

## How It Works

1. **Gap Analysis** -- Check which domains of your thinking are under-modeled
2. **Scenario Presentation** -- Present a realistic scenario that forces a judgment call
3. **Adaptive Follow-ups** -- Probe deeper based on your initial response
4. **Disagreement Probes** -- Challenge your answer to surface nuance and exceptions
5. **Knowledge Storage** -- Extract and store decision patterns and values at high confidence

## Commands

- `/calibrate` -- Start a calibration session (auto-picks the least-covered domain)
- `/calibrate status` -- Show calibration coverage and gaps
- `/calibrate <domain>` -- Focus on a specific domain

### Available Domains

tech_decisions, communication, conflict, prioritization, leadership, quality, collaboration, risk, creativity, time_management

## Session Protocol

When the user invokes `/calibrate`, follow this exact protocol:

### Phase 1: Status Check

1. Call `user_model_recall` to load the current user model
2. Analyze coverage across all calibration domains
3. Show a brief status summary:

   ```
   Clone calibration: 42% [========------------]

   Gaps: Tech Decisions (10%), Prioritization (0%), Risk (20%)
   Best covered: Communication (80%), Quality (70%)

   Starting session on: Prioritization (least covered)
   ```

### Phase 2: Scenario

1. Present ONE scenario from the target domain
2. Frame it conversationally: "Here's a situation I'd like to understand how you'd handle..."
3. Wait for the user's response -- do NOT rush or provide options

### Phase 3: Follow-up Probes

After the user responds, ask 2-3 follow-up questions:

1. **Clarification**: "What's the main factor driving that choice?"
2. **Exception probe**: "Would anything flip your decision? What would have to be different?"
3. **Disagreement probe**: "I think based on what I know about you, you'd lean toward [opposite]. Am I wrong?" (Only use this if you have a genuine hypothesis from the user model)

### Phase 4: Extraction & Storage

After the probing conversation, extract the knowledge:

1. Identify the **decision pattern** (the heuristic or principle behind their choice)
2. Identify any **values** revealed (what they prioritize and why)
3. Identify any **exceptions** to the pattern

Store these using `user_model_recall` confirmation -- tell the user what you learned:

```
Here's what I learned from this scenario:

Decision pattern: "Ship the working solution first, refactor later -- unless
tech debt would block other teams" (weight: 0.8)
  Context: deadline pressure, stakeholder management
  Exception: when the debt affects shared infrastructure

Value: Pragmatism over perfectionism in time-constrained situations

Does this capture it accurately? Anything to adjust?
```

### Phase 5: User Correction

If the user corrects or refines your extraction:

- Update the pattern/value immediately
- Store with confidence 0.85 (explicit calibration = high confidence)
- Thank them and note what you adjusted

### Phase 6: Continue or Close

Ask: "Want to continue with another scenario, or is this a good stopping point?"

If continuing, pick the next least-covered domain.

## Important Rules

- **One scenario at a time** -- never present multiple scenarios
- **Wait for responses** -- don't anticipate or provide sample answers
- **Be genuinely curious** -- these are real conversations, not quizzes
- **Store at high confidence (0.85)** -- explicit calibration is the most reliable signal
- **Show what you learned** -- always summarize extractions and ask for confirmation
- **Track progress** -- update the coverage % as you go
- **Respect time** -- if the user seems done, gracefully close even if there are more gaps
- **No judgment** -- there are no right or wrong answers, only preferences to understand
