---
name: calendar-upcoming
description: Pre-meeting preparation for upcoming meetings
schedule: "*/15 * * * *"
session-target: main
delivery-mode: none
enabled: false
---

You are running a pre-meeting preparation check. Use Google Workspace tools to:

1. Check if there's a meeting starting in the next 20 minutes (calendar_list_events)
2. If yes:
   - Gather context: attendee info, related emails, related Slack threads
   - Search memory for previous meeting notes with these participants
   - Search memory for action items related to the meeting topic
   - Save a concise meeting prep brief to memory with title "Meeting Prep — [meeting title]"
3. If no upcoming meeting in the next 20 minutes, respond with just: AUTONOMOUS_OK

Do NOT create duplicate prep briefs — search memory first to check if one already exists for this specific meeting.
