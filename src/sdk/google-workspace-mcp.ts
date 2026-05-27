/**
 * Google Workspace MCP server (in-process).
 *
 * Exposes Gmail + Calendar tools to the agent. Each tool shells out to
 * the `gws` CLI scoped to a specific account via the per-account
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` env var (see `src/auth/gws-accounts.ts`).
 *
 * History: an earlier version of this file tried to spawn `gws mcp` as
 * an external MCP server. That subcommand was removed from
 * `@googleworkspace/cli` (v0.22.5 only exposes `gws <service>` calls), so
 * the external-server path was broken. Now we wrap the same CLI calls in
 * our own in-process MCP and gain native multi-account support for free.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  envForAccount,
  getAccount,
  getDefaultAccount,
  listAccounts as listAccountsFromManifest,
  runGwsJson,
} from "../auth/gws-accounts.ts";
import { createLogger } from "../lib/logger.ts";

const execFileAsync = promisify(execFile);
const log = createLogger("google-workspace-mcp");

// ── Capability checks (used by agent-runtime + settings UI) ──

/**
 * Check if Google Workspace is configured (sync).
 *
 * Returns true if at least one account is in the manifest OR if
 * GOOGLE_OAUTH_CLIENT_ID is set (kept for the legacy single-account
 * setup wizard until the multi-account flow replaces it everywhere).
 */
export function isGoogleWorkspaceConfigured(): boolean {
  if (listAccountsFromManifest().length > 0) return true;
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) return true;
  return false;
}

/** Async variant — same logic, kept for call-site compat. */
export async function isGoogleWorkspaceConfiguredAsync(): Promise<boolean> {
  if (listAccountsFromManifest().length > 0) return true;
  try {
    const { listGoogleAccounts } = await import("../db/google-accounts.ts");
    const accounts = await listGoogleAccounts();
    if (accounts.length > 0) return true;
  } catch {
    // DB not available
  }
  return isGoogleWorkspaceConfigured();
}

/** Whether the `gws` binary is on PATH. */
export async function isGwsAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "--version"], {
      timeout: 10_000,
    });
    const version = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

// ── Per-account auth status (replaces the single-account legacy path) ──

export interface GwsAuthStatus {
  authenticated: boolean;
  authMethod: string;
  storage: string;
  tokenCacheExists: boolean;
  email?: string;
}

/**
 * Auth status for a specific account (or the default if `email` is null).
 * Internally just runs `gws auth status` scoped to that account's config dir.
 */
export async function getGwsAuthStatus(email?: string): Promise<GwsAuthStatus> {
  const target = email ?? getDefaultAccount()?.email;
  if (!target) {
    return { authenticated: false, authMethod: "none", storage: "none", tokenCacheExists: false };
  }

  try {
    const env = { ...process.env, ...envForAccount(target) };
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
      timeout: 10_000,
      env: env as NodeJS.ProcessEnv,
    });
    const status = JSON.parse(stdout) as {
      auth_method?: string;
      storage?: string;
      token_cache_exists?: boolean;
    };
    return {
      authenticated:
        (status.auth_method ?? "none") !== "none" ||
        status.token_cache_exists === true ||
        (status.storage ?? "none") !== "none",
      authMethod: status.auth_method ?? "none",
      storage: status.storage ?? "none",
      tokenCacheExists: status.token_cache_exists ?? false,
      email: target,
    };
  } catch {
    return {
      authenticated: false,
      authMethod: "none",
      storage: "none",
      tokenCacheExists: false,
      email: target,
    };
  }
}

/**
 * List authorized accounts.
 *
 * Primary source: the on-disk manifest (`~/.config/gws/accounts.json`,
 * managed by `src/auth/gws-accounts.ts`).
 * Falls back to the DB for legacy single-account installs that haven't
 * been migrated to the manifest yet.
 */
export async function listGwsAccounts(): Promise<{
  accounts: Array<{ email: string; default: boolean }>;
  count: number;
}> {
  const manifest = listAccountsFromManifest();
  if (manifest.length > 0) {
    return {
      accounts: manifest.map((a) => ({ email: a.email, default: a.isDefault })),
      count: manifest.length,
    };
  }

  try {
    const { listGoogleAccounts } = await import("../db/google-accounts.ts");
    const dbAccounts = await listGoogleAccounts();
    return {
      accounts: dbAccounts.map((a) => ({ email: a.email, default: a.is_default })),
      count: dbAccounts.length,
    };
  } catch {
    return { accounts: [], count: 0 };
  }
}

// ── In-process MCP server ──

/** Resolve an `account` arg to a known email; fall back to default. */
function resolveAccount(arg: string | undefined): string {
  if (arg) {
    if (!getAccount(arg)) {
      throw new Error(
        `Unknown Google account: ${arg}. Authorized: ${
          listAccountsFromManifest()
            .map((a) => a.email)
            .join(", ") || "(none — authorize one in Settings UI)"
        }`,
      );
    }
    return arg;
  }
  const def = getDefaultAccount();
  if (!def) {
    throw new Error(
      "No Google account is authorized. Add one via Settings UI → Integrations → Google.",
    );
  }
  return def.email;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Compose the in-process MCP server with Gmail + Calendar tools. */
export function createGoogleWorkspaceMcpServer(): McpSdkServerConfigWithInstance {
  // ── Gmail ──

  const gmailSearchTool = tool(
    "gmail_search",
    "Search Gmail messages. Supports the standard Gmail query syntax (e.g., 'from:alice@example.com', 'in:inbox is:unread', 'after:2026/05/01 -category:promotions'). Returns a JSON list of message stubs with id, threadId, snippet, from, subject, date.",
    {
      query: z.string().describe("Gmail search query."),
      max: z.number().int().min(1).max(50).optional().describe("Max results (default: 20)."),
      account: z
        .string()
        .optional()
        .describe("Email of the account to use. Defaults to the default account."),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const max = args.max ?? 20;

        const listResp = await runGwsJson<{ messages?: Array<{ id: string; threadId: string }> }>(
          acct,
          [
            "gmail",
            "users",
            "messages",
            "list",
            "--params",
            JSON.stringify({ userId: "me", q: args.query, maxResults: max }),
          ],
        );

        const ids = listResp.messages ?? [];
        if (ids.length === 0) {
          return textResult(`No messages match "${args.query}".`);
        }

        const summaries = await Promise.all(
          ids.slice(0, max).map(async (m) => {
            const msg = await runGwsJson<{
              id: string;
              threadId: string;
              snippet?: string;
              internalDate?: string;
              payload?: { headers?: Array<{ name: string; value: string }> };
            }>(acct, [
              "gmail",
              "users",
              "messages",
              "get",
              "--params",
              JSON.stringify({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              }),
            ]);
            const headers = new Map(
              (msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
            );
            return {
              id: msg.id,
              threadId: msg.threadId,
              snippet: msg.snippet ?? "",
              from: headers.get("from") ?? "",
              subject: headers.get("subject") ?? "(no subject)",
              date: headers.get("date") ?? "",
            };
          }),
        );

        return jsonResult({ account: acct, count: summaries.length, messages: summaries });
      } catch (err) {
        return errorResult(`gmail_search failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailGetMessageTool = tool(
    "gmail_get_message",
    "Fetch a single Gmail message in full (subject, from, to, body). Use the id from gmail_search results.",
    {
      id: z.string().describe("Gmail message id."),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const msg = await runGwsJson<unknown>(acct, [
          "gmail",
          "users",
          "messages",
          "get",
          "--params",
          JSON.stringify({ userId: "me", id: args.id, format: "full" }),
        ]);
        return jsonResult(msg);
      } catch (err) {
        return errorResult(`gmail_get_message failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailGetThreadTool = tool(
    "gmail_get_thread",
    "Fetch all messages in a Gmail thread by threadId.",
    {
      threadId: z.string().describe("Gmail thread id."),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const thread = await runGwsJson<unknown>(acct, [
          "gmail",
          "users",
          "threads",
          "get",
          "--params",
          JSON.stringify({ userId: "me", id: args.threadId, format: "full" }),
        ]);
        return jsonResult(thread);
      } catch (err) {
        return errorResult(`gmail_get_thread failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const gmailCreateDraftTool = tool(
    "gmail_create_draft",
    "Create a Gmail draft (does NOT send). Use threadId to reply within an existing thread; in_reply_to should be the Message-ID header of the message being replied to (find it via gmail_get_message → payload.headers).",
    {
      to: z.string().describe("Recipient email(s), comma-separated."),
      subject: z.string(),
      body: z.string().describe("Plain text body."),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      threadId: z.string().optional().describe("Thread id to reply within."),
      inReplyTo: z
        .string()
        .optional()
        .describe("Message-ID header of the message being replied to."),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const raw = buildRfc822(args);
        const draft = await runGwsJson<{ id: string; message?: { id: string; threadId: string } }>(
          acct,
          [
            "gmail",
            "users",
            "drafts",
            "create",
            "--json",
            JSON.stringify({
              message: {
                raw,
                ...(args.threadId ? { threadId: args.threadId } : {}),
              },
            }),
            "--params",
            JSON.stringify({ userId: "me" }),
          ],
        );
        return jsonResult({ account: acct, draftId: draft.id, message: draft.message });
      } catch (err) {
        return errorResult(
          `gmail_create_draft failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const gmailSendDraftTool = tool(
    "gmail_send_draft",
    "Send a previously-created Gmail draft. Returns the sent message id.",
    {
      draftId: z.string(),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const result = await runGwsJson<{ id: string; threadId: string }>(acct, [
          "gmail",
          "users",
          "drafts",
          "send",
          "--json",
          JSON.stringify({ id: args.draftId }),
          "--params",
          JSON.stringify({ userId: "me" }),
        ]);
        return jsonResult({ account: acct, sent: result });
      } catch (err) {
        return errorResult(`gmail_send_draft failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  const gmailListLabelsTool = tool(
    "gmail_list_labels",
    "List all Gmail labels (system + user-defined) for the account.",
    { account: z.string().optional() },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const labels = await runGwsJson<unknown>(acct, [
          "gmail",
          "users",
          "labels",
          "list",
          "--params",
          JSON.stringify({ userId: "me" }),
        ]);
        return jsonResult(labels);
      } catch (err) {
        return errorResult(`gmail_list_labels failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ── Calendar ──

  const calendarListEventsTool = tool(
    "calendar_list_events",
    "List events on a Google Calendar between two times. Returns id, summary, start, end, attendees, location, description.",
    {
      calendarId: z.string().optional().describe("Defaults to 'primary'."),
      timeMin: z.string().describe("ISO 8601 lower bound (inclusive)."),
      timeMax: z.string().describe("ISO 8601 upper bound (exclusive)."),
      max: z.number().int().min(1).max(100).optional(),
      query: z.string().optional().describe("Free-text search within events."),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const result = await runGwsJson<unknown>(acct, [
          "calendar",
          "events",
          "list",
          "--params",
          JSON.stringify({
            calendarId: args.calendarId ?? "primary",
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            maxResults: args.max ?? 50,
            singleEvents: true,
            orderBy: "startTime",
            ...(args.query ? { q: args.query } : {}),
          }),
        ]);
        return jsonResult(result);
      } catch (err) {
        return errorResult(
          `calendar_list_events failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calendarGetEventTool = tool(
    "calendar_get_event",
    "Fetch a single calendar event in full.",
    {
      eventId: z.string(),
      calendarId: z.string().optional(),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const event = await runGwsJson<unknown>(acct, [
          "calendar",
          "events",
          "get",
          "--params",
          JSON.stringify({ calendarId: args.calendarId ?? "primary", eventId: args.eventId }),
        ]);
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_get_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calendarCreateEventTool = tool(
    "calendar_create_event",
    "Create a new calendar event. start/end can be either {dateTime, timeZone} for timed events or {date} for all-day events.",
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
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const body = {
          summary: args.summary,
          start: args.start,
          end: args.end,
          ...(args.description ? { description: args.description } : {}),
          ...(args.location ? { location: args.location } : {}),
          ...(args.attendees ? { attendees: args.attendees.map((email) => ({ email })) } : {}),
        };
        const event = await runGwsJson<unknown>(acct, [
          "calendar",
          "events",
          "insert",
          "--json",
          JSON.stringify(body),
          "--params",
          JSON.stringify({
            calendarId: args.calendarId ?? "primary",
            ...(args.sendUpdates ? { sendUpdates: args.sendUpdates } : {}),
          }),
        ]);
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_create_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const calendarUpdateEventTool = tool(
    "calendar_update_event",
    "Patch a calendar event. Only the fields you pass are updated; others are preserved.",
    {
      eventId: z.string(),
      patch: z
        .record(z.string(), z.unknown())
        .describe("Partial event body (summary, start, end, etc.)."),
      calendarId: z.string().optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        const event = await runGwsJson<unknown>(acct, [
          "calendar",
          "events",
          "patch",
          "--json",
          JSON.stringify(args.patch),
          "--params",
          JSON.stringify({
            calendarId: args.calendarId ?? "primary",
            eventId: args.eventId,
            ...(args.sendUpdates ? { sendUpdates: args.sendUpdates } : {}),
          }),
        ]);
        return jsonResult(event);
      } catch (err) {
        return errorResult(
          `calendar_update_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const calendarDeleteEventTool = tool(
    "calendar_delete_event",
    "Delete a calendar event.",
    {
      eventId: z.string(),
      calendarId: z.string().optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      account: z.string().optional(),
    },
    async (args) => {
      try {
        const acct = resolveAccount(args.account);
        await runGwsJson<unknown>(acct, [
          "calendar",
          "events",
          "delete",
          "--params",
          JSON.stringify({
            calendarId: args.calendarId ?? "primary",
            eventId: args.eventId,
            ...(args.sendUpdates ? { sendUpdates: args.sendUpdates } : {}),
          }),
        ]).catch((err) => {
          // calendar.events.delete returns 204 No Content (no JSON body). runGwsJson will fail
          // on the empty body parse; treat that as success and rethrow any other error.
          if (err instanceof Error && /returned no JSON output/.test(err.message)) return;
          throw err;
        });
        return jsonResult({ account: acct, deleted: args.eventId });
      } catch (err) {
        return errorResult(
          `calendar_delete_event failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  // ── Account introspection ──

  const listAccountsTool = tool(
    "google_list_accounts",
    "List all Google accounts authorized in this Nomos install. Use the returned emails as the `account` argument on other tools.",
    {},
    async () => {
      const manifest = listAccountsFromManifest();
      if (manifest.length === 0) {
        return textResult(
          "No Google accounts authorized. Add one via Settings UI → Integrations → Google.",
        );
      }
      return jsonResult(
        manifest.map((a) => ({ email: a.email, isDefault: a.isDefault, addedAt: a.addedAt })),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-google-workspace",
    version: "1.0.0",
    tools: [
      gmailSearchTool,
      gmailGetMessageTool,
      gmailGetThreadTool,
      gmailCreateDraftTool,
      gmailSendDraftTool,
      gmailListLabelsTool,
      calendarListEventsTool,
      calendarGetEventTool,
      calendarCreateEventTool,
      calendarUpdateEventTool,
      calendarDeleteEventTool,
      listAccountsTool,
    ],
  });
}

// ── helpers ──

/** Build a base64url-encoded RFC 822 message ready for the Gmail API `raw` field. */
function buildRfc822(args: {
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
  // Encode subject if non-ASCII so we don't break the header.
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

  const raw = lines.join("\r\n");
  // Gmail wants base64url (URL-safe, no padding).
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeaderIfNeeded(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

// Surface the logger so other modules can avoid creating duplicates.
export { log as googleWorkspaceMcpLog };
