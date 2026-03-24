# Google Ads MCP Integration

Connect Google Ads data to Nomos using the official [Google Ads MCP server](https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server), enabling campaign performance analysis and GAQL queries.

## Prerequisites

- Python 3.10+ with [pipx](https://pipx.pypa.io/stable/#install-pipx) installed
- Google Cloud project with **Google Ads API** enabled
- Google Ads **Developer Token** (from [Google Ads API Center](https://ads.google.com/aw/apicenter))
- OAuth 2.0 credentials or service account

## Setup

### 1. Configure authentication

Set up Application Default Credentials:

```bash
gcloud auth application-default login \
  --scopes https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform \
  --client-id-file=YOUR_CLIENT_SECRET.json
```

Or use a service account credentials JSON file.

### 2. Get a Developer Token

1. Go to your Google Ads account → **Tools & Settings** → **API Center**
2. Apply for a developer token (test accounts get one immediately)

### 3. Add to Nomos MCP config

Add to `.nomos/mcp.json` (project) or `~/.nomos/mcp.json` (global):

```json
{
  "mcpServers": {
    "google-ads-mcp": {
      "command": "pipx",
      "args": [
        "run",
        "--spec",
        "git+https://github.com/googleads/google-ads-mcp.git",
        "google-ads-mcp"
      ],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_PROJECT_ID": "your-project-id",
        "GOOGLE_ADS_DEVELOPER_TOKEN": "your-developer-token"
      }
    }
  }
}
```

### 4. Verify

```bash
nomos chat
> List my Google Ads accounts
```

## Available Tools

| Tool                        | Description                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `list_accessible_customers` | List all accessible Google Ads customer IDs and account names          |
| `search`                    | Execute GAQL queries to retrieve campaign metrics, budgets, and status |

> **Note:** The official MCP server is **read-only** — it cannot modify bids, pause campaigns, or create assets.

## Usage with Digital Marketing Skill

The `digital-marketing` bundled skill includes GAQL query templates and team mode workflows for campaign analysis:

```
/team Analyze my Google Ads performance for the last 30 days and recommend optimizations
```

## References

- [Official documentation](https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server)
- [GitHub repository](https://github.com/googleads/google-ads-mcp)
