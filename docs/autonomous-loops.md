# Autonomous Loops

Autonomous loops are scheduled tasks that run periodically in the daemon, enabling nomos to proactively check channels, triage emails, prepare for meetings, and more — without user prompting.

## How They Work

1. Loop definitions are loaded from `LOOP.md` files and seeded into the database on daemon startup
2. The cron engine evaluates schedules and triggers loops at the configured intervals
3. Each loop execution sends its prompt to the agent runtime as a regular agent turn
4. If nothing needs attention, the agent responds with `AUTONOMOUS_OK` (suppressed from output)
5. Loops that fail repeatedly (3+ consecutive errors) are auto-disabled

## Bundled Loops

The following loops ship with nomos (all disabled by default):

| Name                | Schedule      | Description                                        |
| ------------------- | ------------- | -------------------------------------------------- |
| `slack-digest`      | Every 30 min  | Scan Slack channels for messages needing attention |
| `email-triage`      | Every 15 min  | Triage inbox for unread emails and draft replies   |
| `calendar-prep`     | Daily at 8 AM | Morning calendar briefing with meeting context     |
| `calendar-upcoming` | Every 15 min  | Pre-meeting preparation for upcoming meetings      |

## Managing Loops via CLI

```bash
# List all cron jobs
nomos cron list

# Enable a loop
nomos cron enable slack-digest

# Disable a loop
nomos cron disable slack-digest

# Delete a loop
nomos cron delete slack-digest

# Create a new loop via CLI
nomos cron create my-job "*/5 * * * *" --prompt "Check something and report"

# Create from a file
nomos cron create my-job "0 9 * * *" --file ./my-prompt.txt
```

## Creating Custom Loops

Custom loops use the same `LOOP.md` file format as skills use `SKILL.md`. Each loop lives in its own directory containing a `LOOP.md` file.

### Directory Structure

Loops are loaded from three tiers (higher tiers override lower by name):

```
autonomous/                         # Bundled (repo root)
  slack-digest/LOOP.md
  email-triage/LOOP.md

~/.nomos/autonomous/                # Personal (user-level)
  my-custom-loop/LOOP.md

.nomos/autonomous/                  # Project (workspace-level)
  project-check/LOOP.md
```

### `LOOP.md` Format

```markdown
---
name: my-loop
description: What this loop does
schedule: "*/30 * * * *"
session-target: main
delivery-mode: none
enabled: false
---

Your agent prompt goes here. This is what the agent will execute
each time the loop fires.

If nothing needs attention, respond with just: AUTONOMOUS_OK
```

### Frontmatter Fields

| Field            | Required | Default        | Description                                            |
| ---------------- | -------- | -------------- | ------------------------------------------------------ |
| `name`           | No       | Directory name | Unique identifier for the loop                         |
| `description`    | No       | `""`           | Human-readable description                             |
| `schedule`       | Yes      | —              | Cron expression (e.g., `*/30 * * * *`)                 |
| `session-target` | No       | `main`         | `main` (shared session) or `isolated` (fresh each run) |
| `delivery-mode`  | No       | `none`         | `none` or `announce` (notify channels on findings)     |
| `enabled`        | No       | `false`        | Whether the loop starts enabled                        |

### Body

The markdown body after the frontmatter is the agent prompt. It gets injected as the cron job's `prompt` field. Write it as instructions to the agent — what to check, how to evaluate, and what actions to take.

## Tips for Writing Effective Prompts

- **Be specific about tools**: Name the exact MCP tools the agent should use (e.g., `slack_list_channels`, `gmail_search_emails`)
- **Define prioritization**: Tell the agent what's urgent vs. important vs. ignorable
- **Use `AUTONOMOUS_OK`**: End prompts with "If nothing needs attention, respond with just: AUTONOMOUS_OK" — this convention suppresses empty-result noise
- **Avoid direct actions**: Instruct the agent to draft messages rather than send them directly
- **Check for duplicates**: Tell the agent to search memory before saving, to avoid duplicate entries
- **Keep prompts focused**: Each loop should do one thing well rather than trying to cover everything
