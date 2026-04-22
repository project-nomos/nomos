# Think Like You, Not Just Sound Like You

Most AI clones stop at voice mimicry -- matching your tone, formality, and vocabulary. Nomos goes deeper: it learns **how you think**, **what you value**, **how you make decisions**, and **what your mental state is right now** -- then adapts every response accordingly.

This document covers the full "Think Like You" system: 8 interconnected subsystems that turn raw conversations into a living cognitive model of you.

## Architecture Overview

```
User Message
    |
    v
+---------------------------+
| Theory of Mind (sync)     |  <-- Rule-based: urgency, emotion, focus, energy
| + LLM Assessment (async)  |  <-- Every 3 turns: sarcasm, goals, trajectory
+---------------------------+
    |
    v
+---------------------------+
| System Prompt Assembly    |
| = Identity + User Model   |
|   + Exemplars + Style     |
|   + Mental State          |
|   + Decision Patterns     |
|   + Values                |
+---------------------------+
    |
    v
    Agent Response
    |
    v
+---------------------------+    +---------------------------+
| Memory Indexer (async)    |--->| Knowledge Extractor       |
|   Chunk + embed + store   |    |   Facts, preferences,     |
|                           |    |   corrections, patterns,  |
|                           |    |   values                  |
+---------------------------+    +---------------------------+
    |                                |
    v                                v
+---------------------------+    +---------------------------+
| Exemplar Scorer (async)   |    | User Model Aggregator     |
|   Score message quality   |    |   Merge with confidence   |
|   Store best as few-shot  |    |   tracking                |
+---------------------------+    +---------------------------+
    |
    v
+---------------------------+    +---------------------------+
| Shadow Observer (opt-in)  |    | Auto-Dream Consolidator   |
|   Tool patterns, edits,   |    |   Merge, prune, compress  |
|   file access, cadence    |    |   on schedule             |
+---------------------------+    +---------------------------+
```

All learning runs fire-and-forget after each response -- zero added latency.

---

## 1. Theory of Mind Engine

**File:** `src/memory/theory-of-mind.ts`

Tracks the user's mental state in real time so the agent adapts its response style -- not just what it says, but how it says it.

### Hybrid Architecture

| Layer      | Runs          | Latency    | Catches                                                                             |
| ---------- | ------------- | ---------- | ----------------------------------------------------------------------------------- |
| Rule-based | Every turn    | 0ms        | Urgency markers, explicit emotion, corrections, focus depth, energy/time            |
| LLM        | Every 3 turns | Background | Sarcasm, passive aggression, goal shifts, stuck loops, "this is fine" = resignation |

### State Dimensions

| Dimension      | Values                                               | What it measures                                                             |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Focus          | deep / normal / scattered                            | Code blocks + long exploration = deep; consecutive short replies = scattered |
| Emotion        | neutral / positive / frustrated / stressed / excited | Explicit markers + inferred from correction count, short reply streaks       |
| Cognitive Load | low / moderate / high                                | Average word count + question rate                                           |
| Urgency        | none / mild / high / critical                        | "asap", "blocking", "production down"                                        |
| Energy         | high / normal / low                                  | Time of day + session duration (2h+ = low)                                   |
| Stuck          | boolean                                              | 3+ consecutive questions, corrections, or repetitive short messages          |

### LLM Deep Assessment

Every 3 turns, a background Haiku call analyzes the last 10 messages and produces:

- **Inferred Goal** -- what the user is actually trying to accomplish (may differ from what they asked)
- **Emotional Subtext** -- undercurrent beyond surface signals
- **Conversation Trajectory** -- progressing / stuck / diverging / wrapping_up
- **Strategic Guidance** -- what the agent should do differently

The LLM assessment runs in parallel with the main response via `runForkedAgent`. Results merge into the system prompt on the **next** turn -- zero added latency on the current response.

### Prompt Injection

```
## Current User State
Focus: deep | Emotion: frustrated | Cognitive load: high | Urgency: high | Energy: normal
Assessment: Showing signs of frustration. Dealing with complex topic.

**Response guidance:** Acknowledge the difficulty, be direct and helpful, avoid over-explaining

### Deep Assessment
Inferred goal: Debug the OAuth token refresh failure, not redesign the auth system
Emotional subtext: Frustration is accumulating -- 3 corrections suggest the agent keeps missing the point
Trajectory: stuck
Strategic guidance: Stop suggesting alternatives and focus on the specific error message the user shared
```

---

## 2. Knowledge Extraction

**File:** `src/memory/extractor.ts`

After each conversation turn, a background LLM call extracts structured knowledge into 5 categories:

### What Gets Extracted

| Category              | What it captures                 | Example                                                       |
| --------------------- | -------------------------------- | ------------------------------------------------------------- |
| **Facts**             | User-stated information          | "We use Kubernetes on GKE", "The team is 6 engineers"         |
| **Preferences**       | Explicit preferences             | "I prefer tabs over spaces", "Use pnpm not npm"               |
| **Corrections**       | When the user corrects the agent | "No, don't mock the database -- we use real DB in tests"      |
| **Decision Patterns** | HOW the user thinks              | "Prefers pragmatic solutions over theoretically perfect ones" |
| **Values**            | WHAT the user cares about        | "Values shipping speed over perfect code coverage"            |

### Decision Patterns vs Values

This distinction is key to "thinking like you":

- **Decision Patterns** are heuristics -- how you weigh trade-offs:
  - "When choosing between refactoring and shipping, ships first unless the tech debt is actively causing bugs"
  - "Prefers small PRs over large ones, even if it means more review cycles"
- **Values** are priorities -- what matters to you:
  - "Reliability over features"
  - "Developer experience matters -- tooling should be pleasant to use"

Both include `evidence` (what the user said), `context` (when it applies), and `confidence` (how sure we are).

### Confidence Tracking

Every extracted piece of knowledge has a confidence score (0.0 -- 0.95):

- Repeated confirmation increases confidence: `merge = existing * 0.6 + incoming * 0.4 + 0.05`
- Contradictions decrease confidence by 0.2
- Max confidence is 0.95 (never fully certain)
- Floor is 0.1 (never completely forgotten)
- Corrections mark the original as "superseded" and create a new entry

---

## 3. User Model

**Files:** `src/db/user-model.ts` (CRUD), `src/memory/user-model.ts` (aggregation)

The accumulated knowledge store -- everything the agent has learned about you across all sessions and channels.

### Storage

PostgreSQL table `user_model`:

| Column     | Type   | Purpose                                             |
| ---------- | ------ | --------------------------------------------------- |
| category   | text   | preference, fact, decision_pattern, value, behavior |
| key        | text   | Unique per category (e.g., "async_preference")      |
| value      | jsonb  | Structured data (varies by category)                |
| source_ids | text[] | Memory chunk IDs that contributed                   |
| confidence | float  | 0.0 -- 0.95                                         |

### Prompt Injection

The system prompt includes three sections built from the user model:

**"How You Think"** -- Top 20 decision patterns sorted by weight:

```
- When choosing between refactoring and shipping, ships first unless tech debt is actively causing bugs (weight: 0.85)
- Prefers small PRs over large ones (weight: 0.72)
```

**"Your Guiding Principles"** -- Top 15 values sorted by confidence:

```
- Reliability: Shipping fast matters, but not at the cost of stability (confidence: 0.88)
- DX: Developer experience matters -- tooling should be pleasant (confidence: 0.75)
```

**"What I Know About You"** -- Facts and preferences with confidence >= 0.6:

```
- Uses pnpm as package manager (confidence: 0.92)
- Team is 6 engineers on the platform team (confidence: 0.80)
```

### Accessible via MCP Tool

The agent can recall user model entries via the `user_model_recall` MCP tool:

```
user_model_recall({ category: "decision_pattern" })
```

---

## 4. Exemplar Library

**File:** `src/memory/exemplars.ts`

Real messages you've written, scored and curated as few-shot demonstrations.

### Why Exemplars Matter

LLMs are excellent few-shot learners. Showing the agent 2-3 real messages you've written in a similar context is more powerful than any description of your style. The exemplar system finds and scores your best representative messages.

### Scoring

A background Haiku call rates each message on representativeness (0-1):

| Score     | Meaning                                      |
| --------- | -------------------------------------------- |
| 0.9-1.0   | Highly distinctive -- great few-shot example |
| 0.7-0.8   | Good personality signal                      |
| 0.5-0.6   | Average, some personality                    |
| Below 0.6 | Not stored (generic/boilerplate)             |

### Context Types

Exemplars are tagged by context: `email_formal`, `email_casual`, `slack_casual`, `slack_work`, `code_review`, `technical_discussion`, `personal`, `conflict_resolution`, `planning`, `general`.

### Retrieval

When the agent needs to draft a message, the system retrieves 2-3 contextually matching exemplars via vector search and injects them as a "Voice Examples" section in the system prompt:

```
## Voice Examples
Here are real messages you've written in similar contexts:

> Hey Sarah -- quick heads up, I'm pushing the API change to staging now.
> If anything looks off on your end, ping me. Should be invisible but 🤷

> The migration looks good. One thing: can we add a rollback path?
> Not blocking, just want a safety net before we hit prod.
```

---

## 5. Shadow Observer

**File:** `src/memory/shadow-observer.ts`

Opt-in passive behavioral learning (`NOMOS_SHADOW_MODE=true`). Watches what you do, not just what you say.

### What It Tracks

| Signal               | What it reveals                                            |
| -------------------- | ---------------------------------------------------------- |
| Tool usage sequences | Workflow patterns (always runs tests before committing)    |
| Corrections          | When you reject/modify agent output (implicit preferences) |
| File access patterns | Which files you read/edit frequently                       |
| Response cadence     | Turn timing, how fast you respond                          |

### Distillation

After 20+ observations, Haiku analyzes patterns and extracts 3-5 behavioral insights:

```
- User always runs lint before committing (observed 8 times)
- Prefers reading test files before source files when debugging
- Edits are typically small, focused changes -- rarely rewrites whole files
```

Behavioral patterns are stored in the user model as category `behavior` for cross-session persistence.

---

## 6. Calibration System

**File:** `src/memory/calibration.ts`

Identifies gaps in the user model and provides targeted scenarios to deepen understanding.

### 10 Core Domains

tech_decisions, communication, conflict, prioritization, leadership, quality, collaboration, risk, creativity, time_management

### Gap Detection

Coverage per domain = `patternCoverage * 0.6 + valueCoverage * 0.4`. Domains below 70% are flagged as gaps.

### Scenario Library

20+ realistic dilemmas designed to reveal decision-making patterns:

- "The team wants to adopt a new framework. You've used it on side projects but the team hasn't. Ship date is in 3 weeks."
- "A junior engineer's PR has significant issues but they're visibly proud of it. The code works but won't scale."
- "You discover a security vulnerability in a library you depend on. There's no patch yet."

Each scenario includes follow-up probes to dig deeper into the user's reasoning.

---

## 7. Personality DNA

**File:** `src/memory/personality-dna.ts`

A compact (~2000 token) portable identity document.

### What It Contains

- **Identity** -- summary, roles, expertise areas
- **Top 10 Decision Patterns** -- by weight
- **Top 5 Values** -- by confidence
- **Style Genome** -- compressed communication profile
- **Behavioral Signatures** -- key observed behaviors
- **Exemplar Fingerprints** -- 3-5 characteristic message excerpts

### Use Cases

- **Cold start** -- bootstrap a new instance with your personality
- **Version control** -- snapshot your clone's personality over time
- **Export** -- share your identity profile with other systems

---

## 8. Reflection & Self-Assessment

**File:** `src/memory/reflection.ts`

Powers the `/reflect` skill -- the agent assesses how well it knows you.

### Outputs

- **Synthesis** -- summarized decision style, values, communication preferences, working style
- **Predictions** -- scenario-specific predictions ("Given your style, I think you'd choose X because...")
- **Blind Spots** -- low-confidence areas with suggested probes to fill gaps

---

## How It All Connects

### Learning Loop

1. **You chat** -- every message is processed
2. **Real-time** -- Theory of Mind updates mental state (sync) + kicks off LLM assessment (async)
3. **After response** -- Memory Indexer runs (async):
   - Chunks and embeds the conversation
   - Extracts facts, preferences, corrections, patterns, values
   - Scores the message as a potential exemplar
   - Shadow Observer records tool usage and corrections
4. **User Model updates** -- extracted knowledge merges with confidence tracking
5. **Next turn** -- the updated model informs the next response via system prompt injection
6. **Background** -- Auto-Dream consolidator periodically merges and prunes memory

### What Goes Into the System Prompt

The system prompt for each response includes (when available):

| Section                   | Source                     | Updated               |
| ------------------------- | -------------------------- | --------------------- |
| Identity + personality    | SOUL.md + config           | Static                |
| "How You Think"           | Decision patterns (top 20) | After each extraction |
| "Your Guiding Principles" | Values (top 15)            | After each extraction |
| "What I Know About You"   | Facts + preferences        | After each extraction |
| Voice Examples            | Exemplar library (2-3)     | After scoring         |
| Current User State        | Theory of Mind             | Every turn            |
| Deep Assessment           | LLM reasoning              | Every 3 turns         |
| Communication Style       | Style profiles             | After style analysis  |

### Fire-and-Forget Design

All learning is asynchronous and never blocks the response:

- Knowledge extraction: ~500ms background Haiku call
- Exemplar scoring: ~300ms background Haiku call
- ToM LLM assessment: ~800ms background Haiku call
- Shadow distillation: runs after 20+ observations
- Auto-Dream: runs hourly with 10+ new turns
- Style analysis: runs on demand or after ingestion

---

## Configuration

| Variable                 | Default            | Purpose                                  |
| ------------------------ | ------------------ | ---------------------------------------- |
| `NOMOS_ADAPTIVE_MEMORY`  | `false`            | Enable knowledge extraction + user model |
| `NOMOS_EXTRACTION_MODEL` | `claude-haiku-4-5` | Model for extraction calls               |
| `NOMOS_SHADOW_MODE`      | `false`            | Enable passive behavioral learning       |

Theory of Mind is always active when the daemon processes messages. Calibration runs via the `/calibrate` skill. Reflection via `/reflect`. Personality DNA export via `/personality-dna`.

---

## Design Principles

1. **Zero-latency learning** -- all extraction and scoring runs after the response, never blocking it
2. **Confidence over certainty** -- everything has a confidence score; contradictions reduce it, confirmations increase it, nothing reaches 1.0
3. **Evidence-backed** -- every user model entry cites source chunk IDs for backward tracing
4. **Dual-track mental modeling** -- sync rules catch surface signals instantly, async LLM catches nuance without delay
5. **Real messages over synthetic templates** -- exemplars are your actual words, not generated approximations
6. **Patterns not rules** -- decision patterns capture how you weigh trade-offs, not rigid if/then rules
7. **Graceful degradation** -- each subsystem works independently. Disable adaptive memory and you still get ToM + style. Disable shadow mode and you still get everything else.
