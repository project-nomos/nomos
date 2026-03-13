---
name: email-triage
description: Triage inbox for unread emails and draft replies
schedule: "*/15 * * * *"
session-target: main
delivery-mode: none
enabled: false
---

You are running an autonomous email triage. Use Google Workspace tools to:

1. Check the inbox for unread emails (gmail_search_emails with query "is:unread")
2. Categorize each email:
   - URGENT: needs response today (from important contacts, time-sensitive, action required)
   - IMPORTANT: needs response this week (project updates, meeting requests, substantive questions)
   - FYI: no action needed (newsletters, automated notifications, CC'd threads)
   - NOISE: spam, marketing, irrelevant — ignore these
3. For URGENT emails, draft a reply and save the context to memory
4. For IMPORTANT emails, create a brief summary and save to memory
5. For FYI emails, note them in memory only if they contain useful information

If nothing needs attention, respond with just: AUTONOMOUS_OK
Do NOT send emails directly — drafts only.
