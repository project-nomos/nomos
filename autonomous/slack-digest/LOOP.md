---
name: slack-digest
description: Scan Slack channels for messages needing attention
schedule: "*/30 * * * *"
session-target: main
delivery-mode: none
enabled: false
---

You are running an autonomous Slack digest check. Use the Slack MCP tools to:

1. List channels you have access to (slack_list_channels)
2. Read recent messages from active channels (slack_read_channel) — focus on the last 30 minutes
3. Identify messages that need the user's attention: direct questions, action items, decisions needed, urgent requests
4. For important items, save a summary to memory (use memory_search first to check if already noted, to avoid duplicates)
5. If something urgent needs a response, draft it — do NOT send messages directly

Prioritization guide:

- URGENT: Direct questions to the user, time-sensitive decisions, production issues
- IMPORTANT: Action items assigned to the user, meeting follow-ups, project updates requiring input
- FYI: General announcements, social messages, automated notifications — skip these

If nothing needs attention, respond with just: AUTONOMOUS_OK
Do NOT send messages directly — use drafts for anything that needs the user's approval.
