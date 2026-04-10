/**
 * Priority triage.
 *
 * Aggregates unread/recent messages across all channels,
 * ranks by sender importance and urgency, and produces
 * a periodic summary for the user.
 */

import { getDb } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";

export interface TriageItem {
  platform: string;
  contact: string;
  contactName: string | null;
  messageCount: number;
  lastMessage: string;
  lastTimestamp: string;
  urgency: "high" | "medium" | "low";
  reason: string;
}

export interface TriageSummary {
  items: TriageItem[];
  generatedAt: string;
  totalUnprocessed: number;
}

/**
 * Generate a priority triage of recent unprocessed messages.
 * Groups by contact, ranks by relationship importance + recency.
 */
export async function generateTriage(sinceDays: number = 1): Promise<TriageSummary> {
  const sql = getDb();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  // Get recent received messages grouped by contact
  const groups = await sql<
    {
      contact: string;
      contactName: string | null;
      platform: string;
      msg_count: number;
      last_content: string;
      last_timestamp: string;
    }[]
  >`
    SELECT
      metadata->>'contact' AS contact,
      metadata->>'contactName' AS "contactName",
      metadata->>'platform' AS platform,
      COUNT(*)::int AS msg_count,
      (array_agg(text ORDER BY created_at DESC))[1] AS last_content,
      MAX(metadata->>'timestamp') AS last_timestamp
    FROM memory_chunks
    WHERE metadata->>'source' = 'ingest'
      AND metadata->>'direction' = 'received'
      AND created_at > ${since}
    GROUP BY metadata->>'contact', metadata->>'contactName', metadata->>'platform'
    ORDER BY msg_count DESC
    LIMIT 20
  `;

  if (groups.length === 0) {
    return { items: [], generatedAt: new Date().toISOString(), totalUnprocessed: 0 };
  }

  // Check which contacts have high relationship scores
  const contactIds = groups.map((g) => g.contact).filter(Boolean);
  const relationships = await sql<
    { platform_user_id: string; autonomy: string; role: string | null }[]
  >`
    SELECT ci.platform_user_id, c.autonomy, c.role
    FROM contact_identities ci
    JOIN contacts c ON c.id = ci.contact_id
    WHERE ci.platform_user_id = ANY(${contactIds})
  `;

  const relMap = new Map(relationships.map((r) => [r.platform_user_id, r]));

  // Classify urgency via LLM
  const itemSummaries = groups
    .map(
      (g) =>
        `${g.contactName ?? g.contact} (${g.platform}, ${g.msg_count} msgs): "${g.last_content?.slice(0, 100)}"`,
    )
    .join("\n");

  const result = await runForkedAgent({
    prompt: `Classify urgency for these recent messages. Return a JSON array with one object per item:
[{"contact": "<contact>", "urgency": "high|medium|low", "reason": "<why>"}]

MESSAGES:
${itemSummaries}

Consider: time-sensitive requests = high, questions/follow-ups = medium, FYI/social = low.
Return ONLY the JSON array.`,
    label: "priority-triage",
  });

  let urgencyMap = new Map<string, { urgency: string; reason: string }>();
  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        contact: string;
        urgency: string;
        reason: string;
      }>;
      urgencyMap = new Map(parsed.map((p) => [p.contact, p]));
    }
  } catch {
    // Use defaults
  }

  const items: TriageItem[] = groups.map((g) => {
    const rel = relMap.get(g.contact);
    const urgencyInfo = urgencyMap.get(g.contactName ?? g.contact);

    return {
      platform: g.platform,
      contact: g.contact,
      contactName: g.contactName,
      messageCount: g.msg_count,
      lastMessage: g.last_content?.slice(0, 200) ?? "",
      lastTimestamp: g.last_timestamp,
      urgency:
        (urgencyInfo?.urgency as TriageItem["urgency"]) ??
        (rel?.role === "manager" ? "high" : "medium"),
      reason: urgencyInfo?.reason ?? (rel?.role ? `Role: ${rel.role}` : ""),
    };
  });

  // Sort: high first, then by message count
  items.sort((a, b) => {
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    const diff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    return diff !== 0 ? diff : b.messageCount - a.messageCount;
  });

  return {
    items,
    generatedAt: new Date().toISOString(),
    totalUnprocessed: groups.reduce((sum, g) => sum + g.msg_count, 0),
  };
}
