# Google Workspace setup (hosted mode)

How to create the Google OAuth app the hosted daemon uses to connect a user's
Gmail / Calendar / Drive. In hosted mode the daemon owns the whole OAuth flow:
it holds **one** central OAuth client (client id + secret), runs the consent
flow, stores per-account tokens (encrypted, per user), and feeds them to:

- **Google's official remote MCP servers** (`gmailmcp` / `calendarmcp` /
  `drivemcp`) for read / draft / calendar / drive, and
- **our own `gmail.send` API tool** for sending (opt-in only).

Power-user mode does not use any of this — it uses the `gws` CLI (`gws auth
login`), so this doc is hosted-only.

> The remote MCP servers are a **Google Workspace Developer Preview**. You must
> be enrolled in the preview and enable the MCP APIs below, or those endpoints
> return 403. The direct-REST fallback (`NOMOS_GOOGLE_BACKEND=rest`) calls the
> GA REST APIs and does **not** need the preview.

---

## 1. Create / pick a Google Cloud project

1. Go to the [Cloud Console](https://console.cloud.google.com/) and create a
   project (or pick an existing one). Note the **project id**.
2. Install + init the gcloud CLI if you want to run the commands below
   (otherwise use the Console links).

## 2. Enable the APIs

The GA data APIs (always needed):

```bash
gcloud services enable \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  people.googleapis.com \
  --project=PROJECT_ID
```

The remote **MCP** APIs (Developer Preview — needed for the `official` backend):

```bash
gcloud services enable \
  gmailmcp.googleapis.com \
  calendarmcp.googleapis.com \
  drivemcp.googleapis.com \
  --project=PROJECT_ID
```

If the MCP services aren't visible, you're not enrolled in the
[Workspace Developer Preview Program](https://developers.google.com/workspace/preview)
yet — enroll, or run with `NOMOS_GOOGLE_BACKEND=rest` for now.

## 3. Configure the OAuth consent screen

Console → **Google Auth Platform → Branding / Audience / Data Access**.

1. **App name** + support email.
2. **Audience**: `Internal` if everyone is in your Workspace; otherwise
   `External` and add yourself + testers under **Test users** (the consent
   screen will warn "unverified app" until Google verifies it — fine for
   testing).
3. **Data Access → Add scopes** → paste exactly these (they match
   `GOOGLE_SCOPES` in `src/auth/google-integration.ts`):

   ```
   openid
   email
   profile
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.compose
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events.freebusy
   https://www.googleapis.com/auth/calendar.events.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/drive.file
   ```

   `gmail.readonly`, `calendar.*`, and `drive.readonly` are **sensitive /
   restricted** scopes. They work in testing mode immediately; a _public_
   production app needs Google verification (+ a CASA security assessment for
   the restricted ones). We deliberately avoid `gmail.modify` to stay off the
   heaviest tier.

## 4. Create the OAuth client

Console → **Google Auth Platform → Clients → Create client**.

1. Application type: **Web application**.
2. **Authorized redirect URIs** — add the URI(s) that will receive the `?code`.
   This MUST exactly match `GOOGLE_OAUTH_REDIRECT_URI` on the daemon and the
   callback route in the client:
   - Local web test client: `http://localhost:4100/oauth/google/callback`
   - Hosted web/mobile: `https://<your-app-host>/oauth/google/callback`
3. **Create**, then copy the **Client ID** and **Client secret**.

> One central client is shared by all customers (the daemon holds the secret).
> Add every callback host you'll use to the redirect-URI list.

## 5. Set the daemon env vars

```bash
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4100/oauth/google/callback   # must match step 4
# optional:
NOMOS_GOOGLE_BACKEND=official     # default; use "rest" to bypass the preview MCP
ENCRYPTION_KEY=<64 hex chars>     # encrypts stored tokens (recommended)
```

In production these come from a K8s secret; locally they go in the daemon's
`.env` / `.env.local`. The client secret never leaves the daemon — the web /
mobile callback only relays the authorization `code`.

## 6. Connect an account + test

1. Start the hosted stack (daemon with the env above + the web client on
   `:4100`), sign in.
2. Settings → **Connect Google** → consent screen → back to the app.
3. The account appears under **Connected** with a **Send** toggle (off by
   default — the agent drafts; flip it to allow sending) and a disconnect (×).
4. Ask the agent something that uses Gmail/Calendar/Drive. With
   `NOMOS_GOOGLE_BACKEND=official` the tools come from Google's MCP servers; the
   `gmail_send_*` tools appear only once you enable Send.

### Flow recap

```
Settings "Connect Google"
  → daemon StartConnectIntegration → Google consent URL (signed CSRF state)
  → consent → /oauth/google/callback?code&state  (web client)
  → daemon ConnectGoogleAccount(code,state): verify state, exchange code,
    store per-account tokens (encrypted)
  → /?google=connected ; agent gets the user's Google MCP tools next turn
```

## Troubleshooting

| Symptom                               | Cause / fix                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `redirect_uri_mismatch`               | The redirect URI in step 4 ≠ `GOOGLE_OAUTH_REDIRECT_URI`. They must be byte-identical (scheme, host, port, path).                          |
| `invalid_state` on callback           | The signed state expired (10 min) or the JWT user differs. Re-start the connect.                                                           |
| No refresh token / re-auth every hour | Consent must be fresh — the daemon already sends `access_type=offline&prompt=consent`; if you reused an old grant, disconnect + reconnect. |
| MCP endpoints 403                     | Not enrolled in the Developer Preview, or the `*mcp.googleapis.com` APIs aren't enabled. Use `NOMOS_GOOGLE_BACKEND=rest` meanwhile.        |
| `Google integration not configured`   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` not set on the daemon.                                                                         |
