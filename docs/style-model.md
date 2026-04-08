# Communication Style Model

Nomos learns how you write — globally and per contact — so the digital clone can respond in your authentic voice.

## Overview

The style model analyzes your sent messages to extract writing patterns: formality level, typical message length, emoji usage, punctuation habits, greeting and sign-off patterns. It produces a `StyleProfile` that's injected into the agent's system prompt when drafting messages.

## How It Works

1. **Data source** — Queries `memory_chunks` where `metadata->>'source' = 'ingest' AND metadata->>'direction' = 'sent'`
2. **Batching** — Groups messages by contact for per-contact analysis
3. **Analysis** — Uses a forked agent (Haiku) to extract style features from message samples
4. **Storage** — `StyleProfile` stored as JSONB in `style_profiles` table
5. **Prompt injection** — Converts profile to natural-language instructions merged into system prompt

## Profile Fields

| Field               | Type     | Description                                    |
| ------------------- | -------- | ---------------------------------------------- |
| `formality`         | 1-5      | 1 = very casual, 5 = very formal               |
| `avg_length`        | number   | Average message length in words                |
| `vocabulary`        | string[] | Characteristic words/phrases                   |
| `emoji_usage`       | string   | none, rare, moderate, frequent                 |
| `punctuation`       | object   | Capitalization, exclamation, ellipsis patterns |
| `greeting_patterns` | string[] | Common greetings ("hey", "Hi Sarah,")          |
| `signoff_patterns`  | string[] | Common sign-offs ("cheers", "best,")           |

## Global vs Per-Contact

- **Global profile** (`contact_id = NULL`) — Your overall writing voice, trained on all sent messages
- **Per-contact profiles** — Override the global profile for specific contacts (e.g., more formal with your manager, casual with friends)

When drafting a message, the system merges global + per-contact: per-contact fields take priority where they differ.

## Triggering Analysis

Style analysis runs automatically after ingestion with the `--analyze-style` flag:

```bash
nomos ingest imessage --since 2024-01-01 --analyze-style
```

It can also be triggered from the Settings UI at `/admin/style` with the "Re-analyze" button.

## Confidence

Each profile tracks `sample_count` — the number of messages analyzed. Below 20 samples, the style model is flagged as low-confidence and the agent is warned not to rely heavily on it.

## Configuration

- `app.styleMaxContactsPerBatch` — Max contacts analyzed per batch (default: 50)
- Style profiles are stored in the `style_profiles` table with a unique constraint on `(contact_id, scope)`

## Example Prompt Output

For a casual contact, the style prompt might produce:

> Write casually in lowercase. Keep messages under 50 words. Use 1-2 emojis occasionally. Start with "hey" or jump straight in. No formal sign-off.

For a professional contact:

> Write in a professional but warm tone. Use proper capitalization and punctuation. Typical length: 80-150 words. Start with "Hi [Name]," and close with "Best," or "Thanks,".
