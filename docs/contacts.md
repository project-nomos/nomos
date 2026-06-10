# Cross-Channel Identity Graph

Unified contact management that links identities across Slack, email, iMessage, Discord, Telegram, and WhatsApp into a single profile.

## Overview

People use multiple platforms. The identity graph lets Nomos understand that "Sarah on Slack" and "sarah@company.com" and "+1-555-0123 on iMessage" are the same person. This enables consistent style modeling, relationship-aware responses, and per-contact autonomy levels.

## CLI Usage

```bash
# List all contacts
nomos contacts list
nomos contacts list --platform slack

# Show a contact with all linked identities
nomos contacts show <contact-id>

# Manually link an identity to a contact
nomos contacts link <contact-id> <platform> <platform-user-id>

# Unlink an identity
nomos contacts unlink <identity-id>

# Merge two contacts (consolidate identities)
nomos contacts merge <id1> <id2>
```

## Auto-Linking

The auto-linker (`nomos contacts auto-link`) runs two deterministic, owner-scoped heuristics to merge a user's own duplicate contacts:

1. **Exact email match** — same email across platforms
2. **Case-insensitive display-name match** — same name (any case) across platforms

Merges apply directly (review with `nomos contacts list`/`show`, split via `merge`). There is no fuzzy-similarity matching or inline confirmation flow.

## Contact Fields

### `contacts` table

| Field          | Type  | Description                               |
| -------------- | ----- | ----------------------------------------- |
| `display_name` | TEXT  | Primary display name                      |
| `role`         | TEXT  | colleague, friend, family, client, etc.   |
| `relationship` | JSONB | Relationship metadata (frequency, topics) |
| `autonomy`     | TEXT  | `auto`, `draft`, or `silent`              |
| `data_consent` | TEXT  | `inferred`, `explicit`, or `withdrawn`    |
| `notes`        | TEXT  | Free-form notes                           |

### `contact_identities` table

| Field              | Type | Description                                         |
| ------------------ | ---- | --------------------------------------------------- |
| `contact_id`       | UUID | FK to contacts                                      |
| `platform`         | TEXT | slack, discord, telegram, email, imessage, whatsapp |
| `platform_user_id` | TEXT | Platform-specific user ID                           |
| `display_name`     | TEXT | Name on this platform                               |
| `email`            | TEXT | Email if available                                  |

## Autonomy Levels

Per-contact autonomy controls how the agent handles outgoing messages:

| Level    | Behavior                                                 |
| -------- | -------------------------------------------------------- |
| `auto`   | Messages sent immediately, no approval needed            |
| `draft`  | Draft created for user approval before sending (default) |
| `silent` | Messages discarded — agent observes but doesn't respond  |

Autonomy defaults to `draft` per contact. (A `set-autonomy` CLI subcommand is not yet implemented; the field is set programmatically via `updateContact`.)

## Privacy & Data Rights

- **Data consent tracking** — `data_consent` field tracks consent status per contact (`inferred` / `explicit` / `withdrawn`)
- **No outbound sharing** — Learned data about contacts never leaves the system in responses to third parties

## Settings UI

A dedicated `/admin/contacts` page is planned but not yet built. Contacts are managed today via the CLI (`nomos contacts list/show/link/unlink/merge/auto-link`); the identity graph also surfaces in the `/admin/graph` knowledge-graph view.
