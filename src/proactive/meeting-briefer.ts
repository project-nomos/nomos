/**
 * Meeting briefer.
 *
 * Generates pre-meeting context briefs by:
 * 1. Looking up upcoming calendar events (via Google Workspace MCP)
 * 2. Resolving attendees in the identity graph
 * 3. Retrieving recent conversations with attendees
 * 4. Generating a brief via forked agent
 */

import { getDb } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { findContactByIdentity } from "../identity/identities.ts";
import { getRelevantArticles } from "../memory/wiki-reader.ts";

export interface MeetingBrief {
  eventTitle: string;
  eventTime: string;
  attendees: Array<{
    name: string;
    email: string;
    relationship?: string;
    recentTopics?: string[];
  }>;
  contextSummary: string;
  suggestedAgenda: string[];
}

/**
 * Generate a brief for an upcoming meeting.
 *
 * @param eventTitle - Calendar event title
 * @param eventTime - ISO timestamp
 * @param attendeeEmails - List of attendee emails
 */
export async function generateMeetingBrief(
  eventTitle: string,
  eventTime: string,
  attendeeEmails: string[],
): Promise<MeetingBrief> {
  const sql = getDb();

  // Resolve attendees to contacts
  const attendees: MeetingBrief["attendees"] = [];
  const contextParts: string[] = [];

  for (const email of attendeeEmails) {
    const contact = await findContactByIdentity("email", email);
    const attendee: MeetingBrief["attendees"][0] = {
      name: contact?.display_name ?? email,
      email,
    };

    if (contact) {
      attendee.relationship = contact.role ?? undefined;

      // Get recent conversations with this contact
      const recentMsgs = await sql<{ content: string }[]>`
        SELECT text AS content FROM memory_chunks
        WHERE metadata->>'source' = 'ingest'
          AND metadata->>'contact' = ${email}
        ORDER BY created_at DESC
        LIMIT 10
      `;

      if (recentMsgs.length > 0) {
        contextParts.push(
          `Recent exchanges with ${attendee.name}:\n${recentMsgs
            .map((m) => m.content)
            .join("\n")
            .slice(0, 1000)}`,
        );
      }

      // Check wiki for contact article
      const wikiContext = await getRelevantArticles(attendee.name);
      if (wikiContext) {
        contextParts.push(wikiContext.slice(0, 500));
      }
    }

    attendees.push(attendee);
  }

  // Generate brief via LLM
  const attendeeList = attendees.map((a) => `- ${a.name} (${a.email})`).join("\n");
  const context = contextParts.join("\n\n---\n\n").slice(0, 4000);

  const prompt = `Generate a pre-meeting brief.

MEETING: ${eventTitle}
TIME: ${eventTime}
ATTENDEES:
${attendeeList}

CONTEXT FROM RECENT COMMUNICATIONS:
${context || "(No prior communications found)"}

Return a JSON object:
{
  "contextSummary": "<2-3 sentence summary of relevant context>",
  "suggestedAgenda": ["<item 1>", "<item 2>", ...]
}

Return ONLY the JSON.`;

  const result = await runForkedAgent({
    prompt,
    label: "meeting-brief",
  });

  let contextSummary = "No prior context available.";
  let suggestedAgenda: string[] = [];

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      contextSummary = parsed.contextSummary ?? contextSummary;
      suggestedAgenda = parsed.suggestedAgenda ?? [];
    }
  } catch {
    // Use defaults
  }

  return {
    eventTitle,
    eventTime,
    attendees,
    contextSummary,
    suggestedAgenda,
  };
}
