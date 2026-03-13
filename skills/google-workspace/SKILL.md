---
name: google-workspace
description: "Interact with Google Workspace — Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, Keep, Meet, and more. Uses the @googleworkspace/cli (gws) MCP server which auto-generates tools from Google's Discovery API. Requires gws auth to be configured."
emoji: "🔷"
---

# Google Workspace

Interact with Google Workspace using the MCP tools provided by the `google-workspace` MCP server. This server is powered by `@googleworkspace/cli` (gws), which reads Google's Discovery API at runtime and auto-generates tools for all available services.

## How Tools Work

The gws MCP server generates tools dynamically from Google's API Discovery Service. Tool names follow the pattern `{service}_{resource}_{method}`. For example:

- `gmail_users_messages_list` — list Gmail messages
- `gmail_users_messages_send` — send a Gmail message
- `calendar_events_list` — list calendar events
- `calendar_events_insert` — create a calendar event
- `drive_files_list` — list Drive files
- `drive_files_create` — create a Drive file
- `docs_documents_get` — get a Google Doc
- `sheets_spreadsheets_values_get` — read spreadsheet values
- `slides_presentations_get` — get a presentation
- `tasks_tasks_list` — list tasks
- `people_people_searchContacts` — search contacts

Use `gws schema <service.resource.method>` to see the full parameter schema for any tool.

## Available Services

The gws CLI supports 26+ Google Workspace services. Common ones include:

| Service      | Description                        |
| ------------ | ---------------------------------- |
| `gmail`      | Email — send, read, search, labels |
| `calendar`   | Events, calendars, scheduling      |
| `drive`      | Files, folders, sharing            |
| `docs`       | Google Docs editing                |
| `sheets`     | Spreadsheets                       |
| `slides`     | Presentations                      |
| `forms`      | Forms and responses                |
| `tasks`      | Task management                    |
| `people`     | Contacts                           |
| `chat`       | Google Chat (Workspace only)       |
| `keep`       | Google Keep notes                  |
| `meet`       | Google Meet                        |
| `admin`      | Admin SDK (directory, users)       |
| `classroom`  | Google Classroom                   |
| `youtube`    | YouTube API                        |

Services are controlled by the `GWS_SERVICES` env var (default: `all`).

## Usage Examples

### Search and read emails

Use `gmail_users_messages_list` with Gmail query syntax in the `q` parameter:

- `is:unread` — unread emails
- `from:boss@company.com` — emails from a specific sender
- `subject:invoice after:2024/01/01` — subject and date filters
- `has:attachment filename:pdf` — attachments

Then use `gmail_users_messages_get` with the message ID to read the full email.

### Send an email

Use `gmail_users_messages_send` with a base64url-encoded RFC 2822 message. The tool handles the encoding — provide `to`, `subject`, and body content.

### Manage calendar events

Use `calendar_events_list` with `timeMin` and `timeMax` for date ranges. Use `calendar_events_insert` with summary, start/end times, attendees, and location.

### Work with Drive files

Use `drive_files_list` with `q` parameter for search queries. Use `drive_files_get` with `fileId` and `alt=media` to download content. Use `drive_files_create` to upload new files.

### Edit Google Docs

Use `docs_documents_get` to read the current document, then `docs_documents_batchUpdate` with update requests to insert, delete, or format text.

### Work with Sheets

Use `sheets_spreadsheets_values_get` with spreadsheetId and range (e.g., `Sheet1!A1:D10`). Use `sheets_spreadsheets_values_update` to write data.

## Configuration

### Environment Variables

```bash
GWS_SERVICES=all                        # Services to expose (default: all)
                                         # Options: drive,gmail,calendar,docs,sheets,slides,tasks,people,chat,forms,keep,meet
                                         # Or "all" for everything
GOOGLE_OAUTH_CLIENT_ID=...              # Optional: set via settings UI or gws auth setup
GOOGLE_OAUTH_CLIENT_SECRET=...          # Optional: set via settings UI or gws auth setup
```

### Setup

1. **Via Settings UI**: Go to Settings > Integrations > Google. Enter Client ID and Client Secret, click Save, then click Authorize.
2. **Via CLI**: Run `/integrations google` in the REPL.
3. **Manual**: Run `gws auth setup` (requires gcloud) or manually create a GCP OAuth client and run `gws auth login`.

### Multiple Google Accounts

gws supports multiple authenticated accounts. Use `gws auth login` to add each account. Set a default with `gws auth default --account email@example.com`. The MCP server handles account selection automatically.

## Autonomous Email & Calendar Monitoring

Nomos can autonomously triage emails, prep for meetings, and send calendar briefings using the daemon and autonomous loops. When a user asks you to "watch my inbox", "monitor my email", "prep for meetings", or "brief me on my calendar", **take action directly** — don't just show commands, run them yourself:

1. Check if the daemon is running: `nomos daemon status`
2. If not running, start it: `nomos daemon start`
3. Check current cron jobs: `nomos cron list`
4. Enable the relevant built-in loops:
   - `nomos cron enable email-triage` — triage inbox for unread emails and draft replies (every 15 min)
   - `nomos cron enable calendar-prep` — morning calendar briefing with meeting context (daily at 8 AM)
   - `nomos cron enable calendar-upcoming` — pre-meeting preparation for upcoming meetings (every 15 min)
5. If the user wants custom monitoring, create a loop: `nomos cron create <name> "<schedule>" --prompt "<instructions>"`

**Always execute these commands yourself using Bash** rather than telling the user to run them. If a command is blocked by permission hooks, show the user the exact command so they can run it. Confirm what you did after.

## Tips

- **Gmail queries**: Use the same syntax as Gmail's search bar (`is:unread`, `from:`, `subject:`, `after:`, `before:`, `has:attachment`)
- **Calendar time format**: Use RFC 3339 (`2024-01-15T09:00:00Z`)
- **Drive file IDs**: Found in the URL of any Google Drive file
- **Parameter format**: Most tools accept parameters as JSON via the `params` field
- **Rate limits**: Google API quotas apply. The gws server handles retries automatically.
- **Workspace vs free accounts**: Chat requires a Google Workspace plan. Most other services work with free Google accounts.
- **Multi-account**: gws manages multiple accounts internally. Use `gws auth list` to see all accounts.
