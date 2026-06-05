/**
 * Google Workspace MCP server (in-process, direct REST).
 *
 * Calls the GA Google Workspace REST APIs (gmail/v1, calendar/v3, drive/v3)
 * directly with a per-account OAuth access token resolved from the DB at call
 * time (src/auth/google-integration.ts → getValidAccessToken, which refreshes
 * on expiry). No gws CLI, no Developer-Preview MCP servers.
 *
 * Built PER USER (the factory closes over `userId`), so the same server serves
 * one user across a turn. Multi-account: every tool takes an optional `account`
 * (email) param; omitted → the user's default account. The token is resolved
 * per call, so it never goes stale mid-turn.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createLogger } from "../lib/logger.ts";
import {
  getValidAccessToken,
  isGoogleIntegrationConfigured,
  listGoogleAccounts,
} from "../auth/google-integration.ts";

const log = createLogger("google-rest-mcp");

const GAPI = {
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
} as const;

// ── result helpers (same shape as the agent expects) ──

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ── authed fetch against the Google REST APIs ──

type QueryVal = string | number | boolean | undefined;

/**
 * Authed JSON request. Resolves a fresh token for (userId, account) per call.
 * Returns parsed JSON (or null on 204). Throws with a readable message on
 * missing-token / HTTP error so the tool's catch surfaces it as errorResult.
 */
export async function gapiFetch(opts: {
  userId: string;
  account?: string;
  method: string;
  url: string;
  query?: Record<string, QueryVal | QueryVal[]>;
  body?: unknown;
}): Promise<unknown> {
  const token = await getValidAccessToken(opts.userId, opts.account);
  if (!token) {
    throw new Error(
      `no valid Google token${opts.account ? ` for ${opts.account}` : ""} — reconnect the account in Settings → Integrations → Google`,
    );
  }
  const url = new URL(opts.url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item !== undefined) url.searchParams.append(k, String(item));
    }
  }
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (res.status === 204) return null; // No Content (e.g. delete)
  const raw = await res.text();
  const data = raw ? (JSON.parse(raw) as unknown) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: number; message?: string } } | null)?.error;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${res.status} ${e?.message ?? res.statusText} — token may be revoked or missing scope; reconnect in Settings`,
      );
    }
    throw new Error(`${e?.code ?? res.status} ${e?.message ?? res.statusText}`);
  }
  return data;
}

/** Authed raw-text request (Drive file content / Docs export). */
async function gapiFetchText(opts: {
  userId: string;
  account?: string;
  url: string;
}): Promise<string> {
  const token = await getValidAccessToken(opts.userId, opts.account);
  if (!token) {
    throw new Error(
      `no valid Google token${opts.account ? ` for ${opts.account}` : ""} — reconnect in Settings → Integrations → Google`,
    );
  }
  const res = await fetch(opts.url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// ── RFC822 builder for Gmail raw (copied from google-workspace-mcp.ts) ──

function encodeHeaderIfNeeded(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** base64url-encoded RFC 822 message for the Gmail API `raw` field. */
export function buildRfc822(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${args.to}`);
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  lines.push(`Subject: ${encodeHeaderIfNeeded(args.subject)}`);
  if (args.inReplyTo) {
    lines.push(`In-Reply-To: ${args.inReplyTo}`);
    lines.push(`References: ${args.inReplyTo}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(args.body);
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const MAX_DRIVE_TEXT = 100_000;

/** Compose the in-process MCP server bound to one user. */
export function createGoogleRestMcpServer(userId: string): McpSdkServerConfigWithInstance {
  const account = z
    .string()
    .optional()
    .describe("Email of the connected Google account to use. Defaults to the default account.");

  // ── Gmail ──

  const gmailSearch = tool(
    "gmail_search",
    "Search Gmail messages. Supports standard Gmail query syntax (e.g. 'from:alice@example.com', 'in:inbox is:unread', 'after:2026/05/01 -category:promotions'). Returns message stubs with id, threadId, snippet, from, subject, date.",
    {
      query: z.string().describe("Gmail search query."),
      max: z.number().int().min(1).max(50).optional().describe("Max results (default: 20)."),
      account,
    },
    async (args) => {
      try {
        const max = args.max ?? 20;
        const list = (await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.gmail}/users/me/messages`,
          query: { q: args.query, maxResults: max },
        })) as { messages?: Array<{ id: string; threadId: string }> } | null;

        const ids = list?.messages ?? [];
        if (ids.length === 0) return textResult(`No messages match "${args.query}".`);

        const messages = await Promise.all(
          ids.slice(0, max).map(async (m) => {
            const msg = (await gapiFetch({
              userId,
              account: args.account,
              method: "GET",
              url: `${GAPI.gmail}/users/me/messages/${m.id}`,
              query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
            })) as {
              id: string;
              threadId: string;
              snippet?: string;
              payload?: { headers?: Array<{ name: string; value: string }> };
            };
            const h = new Map(
              (msg.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]),
            );
            return {
              id: msg.id,
              threadId: msg.threadId,
              snippet: msg.snippet ?? "",
              from: h.get("from") ?? "",
              subject: h.get("subject") ?? "(no subject)",
              date: h.get("date") ?? "",
            };
          }),
        );
        return jsonResult({ count: messages.length, messages });
      } catch (err) {
        return errorResult(`gmail_search failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailGetMessage = tool(
    "gmail_get_message",
    "Fetch a single Gmail message in full (headers + body). Use the id from gmail_search.",
    { id: z.string().describe("Gmail message id."), account },
    async (args) => {
      try {
        const msg = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.gmail}/users/me/messages/${args.id}`,
          query: { format: "full" },
        });
        return jsonResult(msg);
      } catch (err) {
        return errorResult(`gmail_get_message failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailGetThread = tool(
    "gmail_get_thread",
    "Fetch all messages in a Gmail thread by threadId.",
    { threadId: z.string().describe("Gmail thread id."), account },
    async (args) => {
      try {
        const thread = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.gmail}/users/me/threads/${args.threadId}`,
          query: { format: "full" },
        });
        return jsonResult(thread);
      } catch (err) {
        return errorResult(`gmail_get_thread failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailCreateDraft = tool(
    "gmail_create_draft",
    "Create a Gmail draft (does NOT send). Use threadId to reply within a thread; inReplyTo is the Message-ID header of the message being replied to (from gmail_get_message → payload.headers).",
    {
      to: z.string().describe("Recipient email(s), comma-separated."),
      subject: z.string(),
      body: z.string().describe("Plain text body."),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      threadId: z.string().optional().describe("Thread id to reply within."),
      inReplyTo: z.string().optional().describe("Message-ID header being replied to."),
      account,
    },
    async (args) => {
      try {
        const draft = (await gapiFetch({
          userId,
          account: args.account,
          method: "POST",
          url: `${GAPI.gmail}/users/me/drafts`,
          body: {
            message: {
              raw: buildRfc822(args),
              ...(args.threadId ? { threadId: args.threadId } : {}),
            },
          },
        })) as { id: string; message?: { id: string; threadId: string } };
        return jsonResult({ draftId: draft.id, message: draft.message });
      } catch (err) {
        return errorResult(
          `gmail_create_draft failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const gmailSendDraft = tool(
    "gmail_send_draft",
    "Send a previously-created Gmail draft by draftId. Returns the sent message id.",
    { draftId: z.string(), account },
    async (args) => {
      try {
        const sent = await gapiFetch({
          userId,
          account: args.account,
          method: "POST",
          url: `${GAPI.gmail}/users/me/drafts/send`,
          body: { id: args.draftId },
        });
        return jsonResult({ sent });
      } catch (err) {
        return errorResult(`gmail_send_draft failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  const gmailSendMessage = tool(
    "gmail_send_message",
    "Compose and SEND an email immediately (skips the draft step). Use threadId/inReplyTo to send within an existing thread.",
    {
      to: z.string().describe("Recipient email(s), comma-separated."),
      subject: z.string(),
      body: z.string().describe("Plain text body."),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      threadId: z.string().optional(),
      inReplyTo: z.string().optional(),
      account,
    },
    async (args) => {
      try {
        const sent = await gapiFetch({
          userId,
          account: args.account,
          method: "POST",
          url: `${GAPI.gmail}/users/me/messages/send`,
          body: { raw: buildRfc822(args), ...(args.threadId ? { threadId: args.threadId } : {}) },
        });
        return jsonResult({ sent });
      } catch (err) {
        return errorResult(
          `gmail_send_message failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const gmailListLabels = tool(
    "gmail_list_labels",
    "List all Gmail labels (system + user-defined) for the account.",
    { account },
    async (args) => {
      try {
        const labels = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.gmail}/users/me/labels`,
        });
        return jsonResult(labels);
      } catch (err) {
        return errorResult(`gmail_list_labels failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ── Calendar ──

  const calendarListEvents = tool(
    "calendar_list_events",
    "List events on a Google Calendar between two times. Returns id, summary, start, end, attendees, location, description.",
    {
      calendarId: z.string().optional().describe("Defaults to 'primary'."),
      timeMin: z.string().describe("ISO 8601 lower bound (inclusive)."),
      timeMax: z.string().describe("ISO 8601 upper bound (exclusive)."),
      max: z.number().int().min(1).max(100).optional(),
      query: z.string().optional().describe("Free-text search within events."),
      account,
    },
    async (args) => {
      try {
        const events = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.calendar}/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events`,
          query: {
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.max ?? 50,
            singleEvents: true,
            orderBy: "startTime",
            q: args.query,
          },
        });
        return jsonResult(events);
      } catch (err) {
        return errorResult(
          `calendar_list_events failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calendarGetEvent = tool(
    "calendar_get_event",
    "Fetch a single calendar event in full.",
    { eventId: z.string(), calendarId: z.string().optional(), account },
    async (args) => {
      try {
        const event = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.calendar}/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events/${encodeURIComponent(args.eventId)}`,
        });
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_get_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calendarCreateEvent = tool(
    "calendar_create_event",
    "Create a calendar event. start/end are {dateTime, timeZone} for timed events or {date} for all-day events.",
    {
      summary: z.string(),
      start: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      }),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      }),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Attendee emails."),
      calendarId: z.string().optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      account,
    },
    async (args) => {
      try {
        const event = await gapiFetch({
          userId,
          account: args.account,
          method: "POST",
          url: `${GAPI.calendar}/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events`,
          query: { sendUpdates: args.sendUpdates },
          body: {
            summary: args.summary,
            start: args.start,
            end: args.end,
            ...(args.description ? { description: args.description } : {}),
            ...(args.location ? { location: args.location } : {}),
            ...(args.attendees ? { attendees: args.attendees.map((email) => ({ email })) } : {}),
          },
        });
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_create_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const calendarUpdateEvent = tool(
    "calendar_update_event",
    "Patch a calendar event. Only the fields you pass are updated; others are preserved.",
    {
      eventId: z.string(),
      patch: z
        .record(z.string(), z.unknown())
        .describe("Partial event body (summary, start, end, etc.)."),
      calendarId: z.string().optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      account,
    },
    async (args) => {
      try {
        const event = await gapiFetch({
          userId,
          account: args.account,
          method: "PATCH",
          url: `${GAPI.calendar}/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events/${encodeURIComponent(args.eventId)}`,
          query: { sendUpdates: args.sendUpdates },
          body: args.patch,
        });
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_update_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const calendarDeleteEvent = tool(
    "calendar_delete_event",
    "Delete a calendar event.",
    {
      eventId: z.string(),
      calendarId: z.string().optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      account,
    },
    async (args) => {
      try {
        await gapiFetch({
          userId,
          account: args.account,
          method: "DELETE",
          url: `${GAPI.calendar}/calendars/${encodeURIComponent(args.calendarId ?? "primary")}/events/${encodeURIComponent(args.eventId)}`,
          query: { sendUpdates: args.sendUpdates },
        });
        return jsonResult({ deleted: args.eventId });
      } catch (err) {
        return errorResult(
          `calendar_delete_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  // ── Drive ──

  const driveSearch = tool(
    "drive_search",
    "Search Google Drive files. `query` is a Drive query string (e.g. \"name contains 'budget'\", \"mimeType='application/pdf'\", \"'me' in owners\"). Returns id, name, mimeType, modifiedTime, owners.",
    {
      query: z.string().describe("Drive query (q parameter)."),
      max: z.number().int().min(1).max(100).optional(),
      account,
    },
    async (args) => {
      try {
        const files = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.drive}/files`,
          query: {
            q: args.query,
            pageSize: args.max ?? 25,
            fields: "files(id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink)",
            orderBy: "modifiedTime desc",
          },
        });
        return jsonResult(files);
      } catch (err) {
        return errorResult(`drive_search failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const driveGetMetadata = tool(
    "drive_get_metadata",
    "Get metadata for a Drive file by id (name, mimeType, size, owners, links).",
    { fileId: z.string(), account },
    async (args) => {
      try {
        const meta = await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.drive}/files/${args.fileId}`,
          query: {
            fields: "id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink,parents",
          },
        });
        return jsonResult(meta);
      } catch (err) {
        return errorResult(
          `drive_get_metadata failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const driveReadContent = tool(
    "drive_read_content",
    "Read the text content of a Drive file. Google Docs/Sheets/Slides are exported to text; plain-text files are downloaded. Binary files (images, etc.) are not supported. Truncated at 100k chars.",
    { fileId: z.string(), account },
    async (args) => {
      try {
        const meta = (await gapiFetch({
          userId,
          account: args.account,
          method: "GET",
          url: `${GAPI.drive}/files/${args.fileId}`,
          query: { fields: "id,name,mimeType" },
        })) as { name?: string; mimeType?: string };
        const mime = meta.mimeType ?? "";

        let url: string;
        if (mime.startsWith("application/vnd.google-apps")) {
          const exportMime = mime.includes("spreadsheet")
            ? "text/csv"
            : mime.includes("presentation")
              ? "text/plain"
              : "text/plain";
          url = `${GAPI.drive}/files/${args.fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
        } else if (
          mime.startsWith("text/") ||
          mime === "application/json" ||
          mime === "application/xml"
        ) {
          url = `${GAPI.drive}/files/${args.fileId}?alt=media`;
        } else {
          return errorResult(
            `drive_read_content: '${meta.name ?? args.fileId}' is ${mime || "binary"} — not readable as text.`,
          );
        }

        let content = await gapiFetchText({ userId, account: args.account, url });
        let truncated = false;
        if (content.length > MAX_DRIVE_TEXT) {
          content = content.slice(0, MAX_DRIVE_TEXT);
          truncated = true;
        }
        return jsonResult({ name: meta.name, mimeType: mime, truncated, content });
      } catch (err) {
        return errorResult(
          `drive_read_content failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ── Account introspection ──

  const listAccountsTool = tool(
    "google_list_accounts",
    "List the Google accounts this user has connected. Use a returned email as the `account` argument on other tools.",
    {},
    async () => {
      const accounts = await listGoogleAccounts(userId);
      if (accounts.length === 0) {
        return textResult(
          "No Google accounts connected. Connect one in Settings → Integrations → Google.",
        );
      }
      return jsonResult(
        accounts.map((a) => ({ email: a.email, isDefault: a.isDefault, scopes: a.scopes })),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-google",
    version: "1.0.0",
    tools: [
      gmailSearch,
      gmailGetMessage,
      gmailGetThread,
      gmailCreateDraft,
      gmailSendDraft,
      gmailSendMessage,
      gmailListLabels,
      calendarListEvents,
      calendarGetEvent,
      calendarCreateEvent,
      calendarUpdateEvent,
      calendarDeleteEvent,
      driveSearch,
      driveGetMetadata,
      driveReadContent,
      listAccountsTool,
    ],
  });
}

/**
 * Build the Google MCP server for a user, or `{}` if Google isn't configured or
 * the user has connected no accounts. The returned server is bound to `userId`.
 */
export async function buildGoogleRestMcpServer(
  userId: string,
): Promise<Record<string, McpSdkServerConfigWithInstance>> {
  if (!isGoogleIntegrationConfigured()) return {};
  let accounts;
  try {
    accounts = await listGoogleAccounts(userId);
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : err },
      "failed to list Google accounts",
    );
    return {};
  }
  if (accounts.length === 0) return {};
  log.info({ userId, accounts: accounts.length }, "registered Google REST MCP server");
  return { "nomos-google": createGoogleRestMcpServer(userId) };
}
