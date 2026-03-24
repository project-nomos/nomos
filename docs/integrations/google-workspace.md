# Google Workspace Integration

Give Nomos access to Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, Keep, Meet, and 26+ Google services. The agent can read, create, and manage content across Google services on your behalf.

This integration runs as an MCP server via `@googleworkspace/cli` (gws) — it doesn't add a "channel" for receiving messages, but gives the agent tools to interact with Google services when responding through any channel (Slack, Discord, terminal, etc.).

## Prerequisites

- A Google account (personal Gmail or Workspace)
- Node.js >= 22 (gws is installed as an npm dependency)

No Python or uvx required — gws is a native Rust binary distributed via npm.

## Setup Options

### Option A: Settings UI (Recommended)

1. Start the settings server: `pnpm settings:dev`
2. Navigate to **Integrations > Google**
3. Enter your **Client ID** and **Client Secret** (from Google Cloud Console)
4. Click **Save to .env**
5. Click **Authorize New Account** — a browser opens for Google OAuth
6. After authorization, the account appears in the list

### Option B: CLI (`/integrations google`)

In the REPL, run:

```
/integrations google
```

This checks your setup status and guides you through configuration.

### Option C: Manual Setup with `gws auth`

If you have the `gcloud` CLI installed:

```bash
# Automated GCP project + OAuth client setup
npx gws auth setup

# Authorize your Google account
npx gws auth login
```

If you already have a GCP project with OAuth credentials:

1. Create `~/.config/gws/client_secret.json`:

```json
{
  "installed": {
    "client_id": "your-client-id.apps.googleusercontent.com",
    "client_secret": "your-client-secret",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "redirect_uris": ["http://localhost"]
  }
}
```

2. Run:

```bash
npx gws auth login
```

## GCP Project Setup (Manual Path)

If not using `gws auth setup`, create credentials manually:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services > OAuth consent screen**
   - Choose **External** (or **Internal** for Workspace)
   - Add your email as a test user
4. Navigate to **APIs & Services > Credentials**
   - Click **Create Credentials > OAuth client ID**
   - Select **Desktop app**
   - Copy the Client ID and Client Secret
5. Enable the APIs you need under **APIs & Services > Library**

> **Note:** You only need to enable the specific APIs you plan to use. The gws CLI will tell you if an API isn't enabled when you try to use it.

## Configuration

### Environment Variables

```bash
# Services to expose via MCP (default: all)
GWS_SERVICES=all
# Options: drive,gmail,calendar,docs,sheets,slides,tasks,people,chat,forms,keep,meet
# Or "all" for everything

# Optional: used by the settings UI to write client_secret.json
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

### Multiple Google Accounts

gws supports multiple authenticated accounts:

```bash
# Add accounts
npx gws auth login                              # First account
npx gws auth login --account work@company.com   # Named account

# List accounts
npx gws auth list

# Set default
npx gws auth default --account work@company.com

# Remove an account
npx gws auth logout --account personal@gmail.com
```

The MCP server handles account selection automatically based on the default account.

## Available Services

The gws CLI supports all Google Workspace APIs via the Discovery Service. Common services:

| Service     | Description                                    |
| ----------- | ---------------------------------------------- |
| `gmail`     | Email — send, read, search, manage labels      |
| `calendar`  | Events, calendars, scheduling                  |
| `drive`     | Files, folders, shared drives, sharing         |
| `docs`      | Google Docs reading and editing                |
| `sheets`    | Spreadsheet reading and writing                |
| `slides`    | Presentation creation and editing              |
| `forms`     | Form creation and response collection          |
| `tasks`     | Task lists and task management                 |
| `people`    | Contacts and contact groups                    |
| `chat`      | Google Chat messages (Workspace accounts only) |
| `keep`      | Google Keep notes                              |
| `meet`      | Google Meet                                    |
| `admin`     | Admin SDK — users, groups, devices             |
| `classroom` | Google Classroom                               |
| `youtube`   | YouTube API                                    |
| `blogger`   | Blogger posts                                  |
| `sites`     | Google Sites                                   |

To limit which services are exposed:

```bash
GWS_SERVICES=gmail,calendar,drive
```

## Troubleshooting

### "Access blocked: This app's request is invalid"

- Make sure you're using **Desktop app** credentials (not Web application)
- Verify the OAuth consent screen is configured
- Check that your email is listed as a test user

### "Access Not Configured" or API disabled errors

- Go to Google Cloud Console > APIs & Services > Library
- Search for and enable the specific API that's failing
- gws will tell you which API to enable in the error message

### OAuth token expired

Tokens refresh automatically. If you encounter persistent auth errors:

```bash
npx gws auth logout
npx gws auth login
```

### gws binary not found

Ensure `@googleworkspace/cli` is installed:

```bash
pnpm add @googleworkspace/cli
```

Verify: `npx gws --version`

### MCP server won't start

- Check `npx gws --version` works
- Check `npx gws auth list` shows accounts
- Check `GWS_SERVICES` env var is valid
- Look at daemon logs for specific error messages

### Rate limiting

Google API quotas vary by service. gws handles rate-limit retries automatically. Check usage in Google Cloud Console under **APIs & Services > Dashboard**.
