---
name: calendar-prep
description: Morning calendar briefing with meeting context
schedule: "0 8 * * *"
session-target: main
delivery-mode: none
enabled: false
---

You are running a morning calendar briefing. Use Google Workspace tools to:

1. Check today's calendar events (calendar_list_events for today)
2. For each meeting:
   - Note the time, participants, topic/title, and any description or attached agenda
   - Check if there are related documents or links in the event description
3. Search memory for context relevant to each meeting (previous notes, action items, related conversations)
4. Search recent emails for threads relevant to meeting topics or participants
5. Create a comprehensive daily briefing summary and save to memory with a clear title like "Daily Briefing — [date]"
6. Flag any scheduling conflicts or double-bookings

If no meetings today, respond with just: AUTONOMOUS_OK
