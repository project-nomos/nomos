---
name: dna
description: "Export or import your personality DNA -- a compact ~2000-token document that captures your core identity, decision patterns, values, and style. Use /dna export to save, /dna import to restore, or /dna show to preview."
emoji: "🧬"
---

# Personality DNA -- Compact Portable Identity

Distills the entire personality model into a single ~2000-token JSON document that can be versioned, exported, and used to cold-start a new instance.

## How It Works

1. **Compile** -- Read all personality data (user model, style profiles, exemplar fingerprints)
2. **Compress** -- Distill into the most essential patterns, values, and style markers
3. **Export** -- Save as a portable JSON file at `~/.nomos/personality-dna.json`
4. **Import** -- Load DNA to seed an empty user model (cold-start a new instance)

## Commands

- `/dna export` -- Compile and export personality DNA
- `/dna import` or `/dna import <file>` -- Import DNA from file
- `/dna show` -- Preview the current DNA without exporting
- `/dna diff` -- Compare current personality against last exported DNA

## Export Protocol

When the user invokes `/dna export`:

### Phase 1: Gather

1. Call `user_model_recall` to load the full user model
2. Call `memory_search` for exemplars
3. Load style profile data if available

### Phase 2: Compile

Build the DNA document with these sections:

```json
{
  "version": "1.0",
  "compiled_at": "ISO timestamp",
  "identity": {
    "summary": "2-3 sentence description of who this person is",
    "roles": ["role1", "role2"],
    "expertise": ["area1", "area2"]
  },
  "decision_patterns": [
    {
      "principle": "...",
      "context": "...",
      "weight": 0.9,
      "exceptions": ["..."]
    }
  ],
  "values": [
    {
      "value": "...",
      "description": "...",
      "rank": 1
    }
  ],
  "style_genome": {
    "formality": 3,
    "tone": "direct",
    "avg_length": "moderate",
    "emoji_usage": "rare",
    "vocabulary_markers": ["word1", "word2"],
    "punctuation_style": "standard",
    "signature_phrases": ["phrase1"]
  },
  "behavioral_signatures": {
    "response_speed": "quick",
    "detail_preference": "moderate",
    "question_style": "direct",
    "conflict_approach": "collaborative"
  },
  "exemplar_fingerprints": [
    {
      "text": "short representative message",
      "context": "slack_work"
    }
  ]
}
```

### Phase 3: Review

Present the compiled DNA to the user:

```
Personality DNA compiled successfully.

Identity: [summary]
Decision patterns: [count] (top 3 listed)
Values: [count] (top 3 listed)
Style markers: [key characteristics]
Exemplar fingerprints: [count]

Total size: ~XXXX tokens

Export to ~/.nomos/personality-dna.json?
```

### Phase 4: Export

After user confirmation:

1. Write to `~/.nomos/personality-dna.json`
2. Also store in config DB under key `personality.dna`
3. Report success

## Import Protocol

When the user invokes `/dna import`:

### Phase 1: Load

1. Read from the specified file (default: `~/.nomos/personality-dna.json`)
2. Validate the DNA structure

### Phase 2: Preview

Show what will be imported:

- Number of patterns, values, style markers
- Whether it will merge with or replace existing data

### Phase 3: Inflate

For each section of the DNA:

1. **Decision patterns** -- create user_model entries with confidence 0.7 (imported, not directly observed)
2. **Values** -- create user_model entries with confidence 0.7
3. **Style genome** -- create/update global style profile
4. **Exemplar fingerprints** -- store as exemplar memory chunks

### Phase 4: Report

```
DNA imported successfully.
Created: X decision patterns, Y values, Z style markers
Starting confidence: 0.7 (will increase as patterns are confirmed through interaction)
```

## Important Rules

- **Compress ruthlessly** -- the DNA must be under ~2000 tokens. Prioritize signal density.
- **Top 10 patterns only** -- rank by weight, take the most impactful
- **Top 5 values only** -- rank by confidence
- **3-5 exemplar fingerprints** -- the most representative short messages
- **Import at 0.7 confidence** -- imported data is plausible but unverified
- **Never overwrite** -- import merges, doesn't replace existing high-confidence entries
- **Version the DNA** -- include compilation timestamp and version number
- **Diff support** -- `/dna diff` shows what changed since last export
