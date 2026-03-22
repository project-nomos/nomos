# Google Analytics MCP Integration

Connect Google Analytics 4 (GA4) data to Nomos using the official [google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) server, enabling traffic analysis, conversion tracking, and real-time reporting.

## Prerequisites

- Python 3.10+ with [pipx](https://pipx.pypa.io/stable/#install-pipx) installed
- Google Cloud project with these APIs enabled:
  - [Google Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com)
  - [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com)
- OAuth credentials or service account with `analytics.readonly` scope

## Setup

### 1. Configure authentication

**Option A: OAuth** (recommended for individual use)

```bash
gcloud auth application-default login \
  --scopes https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform \
  --client-id-file=YOUR_CLIENT_SECRET.json
```

**Option B: Service Account** (for daemon/automated use)

```bash
gcloud auth application-default login \
  --impersonate-service-account=SERVICE_ACCOUNT_EMAIL \
  --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform
```

Note the credentials path shown in the output (typically `~/.config/gcloud/application_default_credentials.json`).

### 2. Add to Nomos MCP config

Add to `.nomos/mcp.json` (project) or `~/.nomos/mcp.json` (global):

```json
{
  "mcpServers": {
    "analytics-mcp": {
      "command": "pipx",
      "args": ["run", "analytics-mcp"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

### 3. Verify

```bash
nomos chat
> Show my Google Analytics account summaries
```

## Available Tools

| Tool                                | Description                                                   |
| ----------------------------------- | ------------------------------------------------------------- |
| `get_account_summaries`             | List all GA4 accounts and properties                          |
| `get_property_details`              | Fetch details for a specific property                         |
| `run_report`                        | Execute GA Data API reports with dimensions, metrics, filters |
| `run_realtime_report`               | Fetch real-time visitor data                                  |
| `get_custom_dimensions_and_metrics` | Retrieve custom GA4 configuration                             |
| `list_google_ads_links`             | List linked Google Ads accounts                               |

## Usage with Digital Marketing Skill

The `digital-marketing` bundled skill includes GA4 report templates and team mode workflows. Enable team mode for parallelized analysis:

```
/team Analyze my website traffic for the last 30 days — sources, landing pages, and conversion funnel
```
