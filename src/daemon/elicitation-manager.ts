/**
 * Elicitation manager — Nomos's host-side handler for MCP elicitation
 * requests (the SDK-native "tool needs to ask the user something" path).
 *
 * Flow:
 *   1. An in-process MCP tool (e.g. `ask_user`) calls `extra.sendRequest`
 *      with an `elicitation/create` payload.
 *   2. The Claude Agent SDK relays the request to our `onElicitation`
 *      callback (see `src/sdk/session.ts`).
 *   3. `handleElicitation()` here renders the question on the channel
 *      where the user is currently talking to the agent, registers a
 *      pending entry keyed by elicitation id, and returns a promise that
 *      resolves when the user answers.
 *   4. Channel adapters call `resolveByButton()` (Slack action) or
 *      `tryConsumeTextReply()` (any channel) to dispatch the answer back.
 *
 * Cleanup: every pending entry has a TTL; expired entries auto-decline so
 * the agent doesn't hang forever if the user walks away.
 */

import { randomUUID } from "node:crypto";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelManager } from "./channel-manager.ts";
import type { AgentEvent, OutgoingMessage } from "./types.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("elicitation-manager");

/** Default timeout — agent's promise auto-rejects after this. */
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes

/** Action ID prefix on Slack buttons. The value carries the elicitation id + option index. */
export const SLACK_ASK_USER_ACTION_PREFIX = "ask_user_option";

/** Schema property name our tool uses for the single-select answer. */
const ANSWER_PROPERTY = "answer";

/**
 * Source context for an elicitation — where to render the question and
 * where to look for a text-reply answer.
 */
export interface ElicitationSource {
  /** Channel platform (e.g. "slack-user:T123", "imessage", "cli"). */
  platform: string;
  /** Channel ID (DM channel, room id, phone number, etc.). */
  channelId: string;
  /** Optional thread id to keep the conversation contained. */
  threadId?: string;
}

interface PendingElicitation {
  id: string;
  source: ElicitationSource;
  /** The agent-facing question. */
  message: string;
  /** Options the user can pick from. */
  options: Array<{ label: string; description?: string }>;
  /** Resolve the agent's `await elicit(...)` call. */
  resolve: (result: ElicitationResult) => void;
  /** Time the request landed; used for TTL. */
  createdAt: number;
  /** TTL handle so we can clear on resolve. */
  ttlTimer: ReturnType<typeof setTimeout>;
  /** Posted message id from the channel adapter (for future deletion/update). */
  postedMessageId?: string;
}

export class ElicitationManager {
  private pending = new Map<string, PendingElicitation>();
  /** Reverse index: channelId → pending id, for fast text-reply lookup. */
  private byChannel = new Map<string, string>();
  /** Per-channel event emitters for clients without a channel adapter (mobile/terminal):
   *  render the question over the open Chat stream and accept the answer out-of-band. */
  private emitters = new Map<string, (e: AgentEvent) => void>();

  constructor(private readonly channelManager: ChannelManager) {}

  /** Register an event emitter for a source so renderQuestion can push an `ask` event. */
  registerEmitter(source: ElicitationSource, emit: (e: AgentEvent) => void): void {
    this.emitters.set(channelKeyFor(source), emit);
  }

  unregisterEmitter(source: ElicitationSource): void {
    this.emitters.delete(channelKeyFor(source));
  }

  /** Resolve a pending elicitation by id (out-of-band answer via a client RPC). */
  resolveById(id: string, answer: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const matched = matchOption(answer, entry.options);
    const label =
      matched !== null && matched !== "ambiguous" ? entry.options[matched].label : answer;
    this.resolvePending(entry, { action: "accept", content: { [ANSWER_PROPERTY]: label } });
    return true;
  }

  /**
   * Handle an MCP elicitation request from the agent SDK. Resolves with
   * the user's answer when they click a button or reply with a matching
   * text. Auto-declines if no answer arrives within the TTL.
   */
  async handleElicitation(
    request: ElicitationRequest,
    source: ElicitationSource,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    // URL-mode elicitations (OAuth) aren't our use case — decline.
    if (request.mode === "url") {
      log.warn({ url: request.url }, "URL-mode elicitation not supported; declining");
      return { action: "decline" };
    }

    const options = extractOptionsFromSchema(request.requestedSchema);
    if (options.length === 0) {
      log.warn(
        { schema: request.requestedSchema },
        "Elicitation has no enumerated options; declining (only single-select forms are supported)",
      );
      return { action: "decline" };
    }

    const id = randomUUID();

    const channelKey = channelKeyFor(source);
    // If a previous pending question on this channel is unanswered, cancel it
    // — the agent should never have two open questions in one channel.
    const prior = this.byChannel.get(channelKey);
    if (prior) {
      const p = this.pending.get(prior);
      if (p) {
        log.warn({ priorId: prior, channelKey }, "Cancelling stale elicitation on same channel");
        clearTimeout(p.ttlTimer);
        p.resolve({ action: "cancel" });
        this.pending.delete(prior);
      }
    }

    const promise = new Promise<ElicitationResult>((resolve) => {
      const ttlTimer = setTimeout(() => {
        const stale = this.pending.get(id);
        if (!stale) return;
        log.warn({ id, channelKey }, "Elicitation TTL expired; auto-declining");
        this.pending.delete(id);
        this.byChannel.delete(channelKey);
        stale.resolve({ action: "decline" });
      }, DEFAULT_TTL_MS);

      const entry: PendingElicitation = {
        id,
        source,
        message: request.message,
        options,
        resolve,
        createdAt: Date.now(),
        ttlTimer,
      };
      this.pending.set(id, entry);
      this.byChannel.set(channelKey, id);

      // If the agent aborts (timeout, user cancels), clean up.
      signal.addEventListener(
        "abort",
        () => {
          const e = this.pending.get(id);
          if (!e) return;
          clearTimeout(e.ttlTimer);
          this.pending.delete(id);
          this.byChannel.delete(channelKey);
          e.resolve({ action: "cancel" });
        },
        { once: true },
      );
    });

    // Render the question. Slack gets Block Kit buttons; everything else
    // gets a numbered text message and awaits a text reply.
    await this.renderQuestion(id, request.message, options, source).catch((err) => {
      log.error(
        { err: err instanceof Error ? err.message : err, id, source },
        "Failed to render elicitation on channel",
      );
    });

    return promise;
  }

  /**
   * Resolve a pending elicitation by Slack action_id button click. The
   * Slack adapter calls this from its `app.action(ASK_USER_PREFIX, ...)`
   * handler. Returns true if the click resolved a pending entry.
   */
  resolveByButton(actionValue: string): { resolved: boolean; label?: string } {
    const parsed = parseActionValue(actionValue);
    if (!parsed) return { resolved: false };

    const entry = this.pending.get(parsed.id);
    if (!entry) return { resolved: false };

    const option = entry.options[parsed.index];
    if (!option) return { resolved: false };

    this.resolvePending(entry, { action: "accept", content: { [ANSWER_PROPERTY]: option.label } });
    return { resolved: true, label: option.label };
  }

  /**
   * Try to consume an incoming text message as a reply to a pending
   * elicitation on the same channel. Returns true if the message was
   * consumed (caller should NOT forward to the agent in that case).
   *
   * Matching: numeric ("1", "2"), bare label, or label substring. Case
   * insensitive. Refuses ambiguous substring matches.
   */
  tryConsumeTextReply(source: ElicitationSource, text: string): boolean {
    const key = channelKeyFor(source);
    const id = this.byChannel.get(key);
    if (!id) return false;

    const entry = this.pending.get(id);
    if (!entry) return false;

    const matched = matchOption(text, entry.options);
    if (matched === null) return false; // not a parseable answer — leave for agent
    if (matched === "ambiguous") {
      // Don't consume; the user will retry. Optionally we could nudge here.
      log.info({ id, text }, "Ambiguous answer; leaving message for agent");
      return false;
    }

    const option = entry.options[matched];
    this.resolvePending(entry, { action: "accept", content: { [ANSWER_PROPERTY]: option.label } });
    return true;
  }

  /** Number of pending elicitations (for debugging / tests). */
  pendingCount(): number {
    return this.pending.size;
  }

  // ── internals ──

  private resolvePending(entry: PendingElicitation, result: ElicitationResult): void {
    clearTimeout(entry.ttlTimer);
    this.pending.delete(entry.id);
    this.byChannel.delete(channelKeyFor(entry.source));
    entry.resolve(result);
  }

  private async renderQuestion(
    id: string,
    message: string,
    options: Array<{ label: string; description?: string }>,
    source: ElicitationSource,
  ): Promise<void> {
    // Mobile / terminal clients have no channel adapter — render the question over the
    // open Chat stream via the registered emitter, and accept the answer out-of-band.
    const emit = this.emitters.get(channelKeyFor(source));
    if (emit) {
      emit({
        type: "ask",
        id,
        prompt: message,
        options: options.map((o, i) => ({
          label: o.label,
          desc: o.description,
          key: String(i + 1),
        })),
        multiSelect: false,
      });
      return;
    }

    const adapter = this.channelManager.getAdapter(source.platform);
    if (!adapter) {
      throw new Error(`No adapter for platform ${source.platform}`);
    }

    // Slack: render Block Kit buttons via postMessage on the bot/user client.
    // We piggy-back on the adapter's `postMessage` if it accepts blocks via a
    // typed extension. Slack adapter exposes a `postBlocks` helper when present.
    const slackPoster = (
      adapter as unknown as {
        postBlocks?: (
          channelId: string,
          text: string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          blocks: any[],
          threadId?: string,
        ) => Promise<string | undefined>;
      }
    ).postBlocks;

    if (slackPoster) {
      const blocks = buildSlackBlocks(id, message, options);
      const fallbackText = `${message}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`;
      const messageId = await slackPoster(source.channelId, fallbackText, blocks, source.threadId);
      const entry = this.pending.get(id);
      if (entry) entry.postedMessageId = messageId;
      return;
    }

    // Generic fallback: post numbered text and let the user reply with the
    // number or label. tryConsumeTextReply will match either.
    const numbered = options
      .map((o, i) => `${i + 1}. *${o.label}*${o.description ? ` — ${o.description}` : ""}`)
      .join("\n");
    const outgoing: OutgoingMessage = {
      inReplyTo: id,
      platform: source.platform,
      channelId: source.channelId,
      threadId: source.threadId,
      content: `${message}\n\n${numbered}\n\n_Reply with the number or label to answer._`,
    };
    await adapter.send(outgoing);
  }
}

// ── helpers ──

function channelKeyFor(s: ElicitationSource): string {
  return s.threadId ? `${s.platform}|${s.channelId}|${s.threadId}` : `${s.platform}|${s.channelId}`;
}

/**
 * Pull the option labels out of an MCP elicitation form schema. We only
 * support the simple "one string property with an enum" shape that
 * `ask_user` produces — anything else falls through with no options.
 */
function extractOptionsFromSchema(
  schema: ElicitationRequest["requestedSchema"],
): Array<{ label: string; description?: string }> {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return [];
  const prop = properties[ANSWER_PROPERTY] as
    | { enum?: unknown[]; enumNames?: string[]; oneOf?: Array<{ const: string; title?: string }> }
    | undefined;
  if (!prop) return [];

  if (Array.isArray(prop.oneOf)) {
    return prop.oneOf.map((o) => ({ label: o.title ?? o.const }));
  }

  if (Array.isArray(prop.enum)) {
    const labels = prop.enum.filter((v): v is string => typeof v === "string");
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return labels.map((label, i) => ({ label: names[i] ?? label }));
  }

  return [];
}

function parseActionValue(value: string): { id: string; index: number } | null {
  // value is `<elicitation-id>::<option-index>`
  const sep = value.indexOf("::");
  if (sep < 0) return null;
  const id = value.slice(0, sep);
  const indexStr = value.slice(sep + 2);
  const index = Number.parseInt(indexStr, 10);
  if (!id || Number.isNaN(index) || index < 0) return null;
  return { id, index };
}

function matchOption(text: string, options: Array<{ label: string }>): number | "ambiguous" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Numeric match: "1", "2", "1.", "(1)"
  const num = trimmed.match(/^[\s(]*(\d+)[\s).]*$/);
  if (num) {
    const n = Number.parseInt(num[1], 10);
    if (n >= 1 && n <= options.length) return n - 1;
    return null;
  }

  // Exact-label match (case insensitive)
  const lower = trimmed.toLowerCase();
  const exact = options.findIndex((o) => o.label.toLowerCase() === lower);
  if (exact >= 0) return exact;

  // Substring match — only if exactly one option contains the text
  const substringMatches = options
    .map((o, i) => ({ i, contains: o.label.toLowerCase().includes(lower) }))
    .filter((m) => m.contains);
  if (substringMatches.length === 1) return substringMatches[0].i;
  if (substringMatches.length > 1) return "ambiguous";

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSlackBlocks(
  id: string,
  message: string,
  options: Array<{ label: string; description?: string }>,
): unknown[] {
  // Block Kit limits action elements to 5 per actions block; we cap at 4
  // (matches ask_user's 2-4 options contract anyway).
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Nomos asks:* ${message}` },
    },
    ...options
      .filter((o) => o.description)
      .map((o) => ({
        type: "context",
        elements: [{ type: "mrkdwn", text: `*${o.label}* — ${o.description}` }],
      })),
    {
      type: "actions",
      elements: options.map((o, i) => ({
        type: "button",
        text: { type: "plain_text", text: o.label.slice(0, 75) },
        action_id: `${SLACK_ASK_USER_ACTION_PREFIX}:${i}`,
        value: `${id}::${i}`,
      })),
    },
  ];
}
