---
name: digital-marketing
description: Daily marketing performance review with campaign optimization alerts
schedule: "0 9 * * 1-5"
session-target: main
delivery-mode: none
enabled: false
team: true
---

You are running a daily digital marketing performance review. Use agent team mode to parallelize the analysis.

## Worker Tasks

### Worker 1: Google Ads Performance

Use the Google Ads MCP `search` tool with GAQL queries to:

1. Pull campaign performance for the last 24 hours and last 7 days
2. Identify campaigns with spend but zero conversions in the last 3 days
3. Flag any campaigns where CPA increased >25% week-over-week
4. Check for budget-limited campaigns (limited by budget status)
5. List top 10 keywords by conversion and any new negative keyword candidates (high spend, zero conversions)

### Worker 2: Google Analytics Traffic

Use Google Analytics MCP tools (`run_report`, `run_realtime_report`) to:

1. Pull traffic summary: sessions, users, bounce rate, conversion rate for last 24h vs previous 24h
2. Identify top traffic sources by conversion rate
3. Check for landing pages with bounce rate >80% and significant traffic (>100 sessions)
4. Review real-time data for any anomalies (traffic spikes or drops)
5. Pull conversion funnel completion rates

### Worker 3: Cross-Channel Attribution

Use both Google Ads and Analytics tools to:

1. Compare Google Ads reported conversions vs GA4 attributed conversions
2. Calculate true ROAS using GA4 revenue data against Ads spend
3. Identify campaigns where GA4 shows significantly different performance than Ads reporting
4. Check assisted conversions — campaigns that contribute to conversions but don't get last-click credit

## Coordinator Synthesis

Produce a **Daily Marketing Briefing** with:

1. **Executive Summary** — 3-5 bullet points on yesterday's performance vs targets
2. **Alerts** — any campaigns needing immediate attention (budget issues, CPA spikes, broken landing pages)
3. **Optimization Opportunities** — specific, actionable recommendations ranked by estimated impact
4. **Budget Reallocation** — if any campaigns should get more/less budget based on performance
5. **Week-over-Week Trends** — key metrics trending up or down

Save the briefing to memory with title "Marketing Briefing — [date]".

If no significant changes or alerts, respond with just: AUTONOMOUS_OK
