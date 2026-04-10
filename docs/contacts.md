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

After ingestion, the auto-linker runs heuristics to merge contacts:

1. **Exact display name match** — Same name across platforms
2. **Email match** — Platform profile email matches
3. **Fuzzy name match** — Similar names with high confidence
4. **User confirmation** — Suggested merges presented for approval

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

Set via CLI or Settings UI:

```bash
# Set autonomy for a contact
nomos contacts set-autonomy <contact-id> auto
```

## Privacy & Data Rights

- **Per-contact deletion** — `nomos contacts forget <id>` removes all ingested messages, wiki articles, style profiles, and memory chunks
- **Data consent tracking** — `data_consent` field tracks consent status per contact
- **No outbound sharing** — Learned data about contacts never leaves the system in responses to third parties

## Settings UI

Contact management is available at `/admin/contacts`:

- List contacts with linked identities
- Search and filter by platform, name, or role
- Merge/split contacts
- Set autonomy levels
- View relationship metadata
