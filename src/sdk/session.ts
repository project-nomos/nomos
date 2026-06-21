import {
  query,
  type Query,
  type Options,
  type McpServerConfig,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SdkPluginConfig,
  type OnElicitation,
  type HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
import { getPromptCacheTracker } from "./cache-break-detection.ts";
import { getToolResultStore } from "./tool-result-storage.ts";

export type {
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  McpServerConfig,
  SdkPluginConfig,
  OnElicitation,
};

export interface RunSessionParams {
  /**
   * The user prompt to send. A string runs a one-shot turn (the generator ends at
   * `result`). An `AsyncIterable<SDKUserMessage>` opens a STREAMING-INPUT session:
   * the generator stays alive past `result` and the host can push further messages
   * into the live loop (the substrate for live wait-and-resume / `streamInput`).
   * String callers are unchanged. See `Query.streamInput` / `backgroundTasks`.
   */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Claude model to use */
  model?: string;
  /** Text appended to Claude Code's default system prompt */
  systemPromptAppend?: string;
  /**
   * Text appended to the claude_code preset, taking precedence over
   * systemPromptAppend. NOTE: still an `append` to the preset (the SDK builds
   * `{ preset: "claude_code", append }`), NOT a full replacement — Nomos always
   * keeps Claude Code's base prompt.
   */
  systemPrompt?: string;
  /** Custom Anthropic API base URL (for Ollama, LiteLLM, etc.) */
  anthropicBaseUrl?: string;
  /** MCP servers (external + in-process) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission mode for the session */
  permissionMode?: Options["permissionMode"];
  /** Thinking configuration */
  thinking?: Options["thinking"];
  /** Resume a previous SDK session by ID */
  resume?: string;
  /** Maximum turns before stopping */
  maxTurns?: number;
  /** Maximum budget in USD before stopping */
  maxBudgetUsd?: number;
  /**
   * OS-level sandbox settings (filesystem + network confinement via the SDK's
   * SandboxSettings: enabled / failIfUnavailable / autoAllowBashIfSandboxed /
   * network.allowedDomains / allowAppleEvents / …). Power-user opt-in (Phase E).
   */
  sandbox?: Options["sandbox"];
  /** SDK betas to enable */
  betas?: Options["betas"];
  /** Fallback models to try if primary model fails */
  fallbackModels?: string[];
  /**
   * Force structured JSON output. The SDK validates the model's output against
   * this JSON Schema (with bounded retry) and returns it on
   * `result.structured_output`. Use instead of regex + JSON.parse. (Phase C.)
   */
  outputFormat?: Options["outputFormat"];
  /** Tool names that are auto-allowed without prompting for permission */
  allowedTools?: string[];
  /** Tool names that are blocked entirely (removed from the agent's tool list) */
  disallowedTools?: string[];
  /** Enable SDK debug mode (verbose logging) */
  debug?: boolean;
  /** Callback for stderr output from the Claude Code process */
  stderr?: (data: string) => void;
  /** Working directory for the agent (e.g., git worktree path) */
  cwd?: string;
  /** Plugins to load into the SDK session */
  plugins?: SdkPluginConfig[];
  /** Use Claude subscription (Max/Pro) instead of API key */
  useSubscription?: boolean;
  /**
   * Callback for MCP elicitation requests (e.g. our `ask_user` tool).
   * The SDK calls this when an in-process MCP server invokes
   * `extra.sendRequest({method: "elicitation/create", ...})`. Return an
   * accept/decline/cancel response. If omitted, all elicitations are
   * automatically declined.
   */
  onElicitation?: OnElicitation;
  /** SDK-native hook callbacks (PreToolUse blocking, PostToolUse context, etc.) */
  hooks?: Options["hooks"];
  /** Reasoning effort ('low'..'max'; 'xhigh' is the ultracode level). */
  effort?: Options["effort"];
  /**
   * AbortController whose `abort()` cancels the turn (kills the SDK subprocess,
   * stops billing). Used by the one-shot path; the live path interrupts via
   * `Query.interrupt()` instead so the held-open session survives (D.2).
   */
  abortController?: AbortController;
  /**
   * Persist the SDK session transcript to disk (default true). Set false for
   * one-shot forks whose transcripts are never resumed (Appendix). Mutually
   * exclusive with the SDK `sessionStore` option.
   */
  persistSession?: boolean;
  /**
   * Keep file-edit checkpoints for `Query.rewindFiles` (default true). Set false
   * for forks (they never rewind) to drop the per-edit backup overhead (D.4).
   */
  enableFileCheckpointing?: boolean;
}

/**
 * Build a PostToolUse hook that deduplicates large, repeated tool outputs via
 * the content-addressed ToolResultStore. Opt-in (NOMOS_TOOL_DEDUP) and LOSSY by
 * design -- once a big result is replaced by a reference the model can only
 * recall its earlier copy -- so it is off by default. Per-process, not
 * per-tenant; never persisted.
 */
function buildDedupHooks(): Partial<Record<string, HookCallbackMatcher[]>> | undefined {
  if (process.env.NOMOS_TOOL_DEDUP !== "true") return undefined;
  const store = getToolResultStore();
  return {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            const i = input as { tool_name?: string; tool_response?: unknown };
            const name = i.tool_name ?? "unknown";
            const resp = i.tool_response;
            let text: string | undefined;
            if (typeof resp === "string") {
              text = resp;
            } else if (
              resp &&
              typeof resp === "object" &&
              Array.isArray((resp as { content?: unknown }).content)
            ) {
              const content = (resp as { content: Array<{ type?: string; text?: string }> })
                .content;
              text = content.find((b) => b?.type === "text")?.text;
            }
            if (typeof text !== "string") return {};
            const out = store.processResult(name, text);
            if (!out.deduplicated) return {};
            const updated =
              typeof resp === "string"
                ? out.content
                : { ...(resp as object), content: [{ type: "text", text: out.content }] };
            return {
              hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: updated },
            };
          },
        ],
      },
    ],
  };
}

/** Merge two hook maps, concatenating the matcher arrays per event. */
function mergeHooks(a: Options["hooks"], b: Options["hooks"]): Options["hooks"] {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, HookCallbackMatcher[]> = {
    ...(a as Record<string, HookCallbackMatcher[]>),
  };
  for (const [event, matchers] of Object.entries(b as Record<string, HookCallbackMatcher[]>)) {
    out[event] = [...(out[event] ?? []), ...matchers];
  }
  return out as Options["hooks"];
}

/**
 * Wraps the Claude Agent SDK `query()` call.
 * Returns the async generator of SDK messages.
 */
export function runSession(params: RunSessionParams): Query {
  // Build system prompt config.
  // B.4 — `excludeDynamicSections: true` drops the SDK's own per-environment
  // sections (cwd/OS/git status/date) from the cached prefix. Those vary per env
  // on a long-lived daemon and bust the prompt cache; Nomos injects the runtime
  // context it actually needs via systemPromptAppend, so excluding the SDK's is a
  // cache win with no behavior loss.
  let systemPrompt: Options["systemPrompt"];
  if (params.systemPrompt) {
    systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: params.systemPrompt,
      excludeDynamicSections: true,
    };
  } else if (params.systemPromptAppend) {
    systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: params.systemPromptAppend,
      excludeDynamicSections: true,
    };
  } else {
    systemPrompt = { type: "preset", preset: "claude_code", excludeDynamicSections: true };
  }

  // Build env, including custom base URL if provided.
  // Remove CLAUDECODE so the SDK subprocess doesn't think it's nested inside Claude Code.
  // Must delete the key entirely -- setting to undefined leaves it as "" in the child process.
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "nomos/0.1.0",
  };
  delete env.CLAUDECODE;

  // A.3 — Hermetic runtime. `settingSources: []` (in the options below) gates most
  // filesystem `.claude/` config, but Claude Code's auto-memory loads into the system
  // prompt UNCONDITIONALLY, so disable it explicitly. Nomos owns its own memory (the
  // vault + digest), so this prevents stray `.claude/projects/*/memory` leakage. Opt
  // back in with NOMOS_AUTO_MEMORY=1.
  if (process.env.NOMOS_AUTO_MEMORY !== "1") {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }
  // A.4 — Tool search: collapse 13+ MCP servers' tool schemas out of the per-turn
  // context (defaults to "auto"). It self-disables on non-first-party / Vertex hosts,
  // so when a custom base URL is set we do NOT force it on (the proxy would have to
  // forward `tool_reference` blocks); honor only an explicit operator value there.
  if (!params.anthropicBaseUrl && !env.ENABLE_TOOL_SEARCH) {
    env.ENABLE_TOOL_SEARCH = "auto";
  }

  // Subscription mode: remove API key so the SDK subprocess uses the
  // Claude subscription (Max/Pro) OAuth credentials from ~/.claude/.credentials.json.
  // This avoids API rate limits and uses the subscription's higher limits instead.
  if (params.useSubscription) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
  }
  if (params.anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = params.anthropicBaseUrl;
  }

  // Debug-only: warn when the system prompt / tools / model / betas change in a
  // way that would invalidate the Anthropic prompt cache. Process-wide singleton,
  // so concurrent sessions can over-report -- keep it a debug log, not a metric.
  if (process.env.NOMOS_CACHE_DEBUG === "true") {
    getPromptCacheTracker().check({
      systemPrompt: params.systemPrompt ?? params.systemPromptAppend ?? "",
      toolSchemas: Object.keys(params.mcpServers ?? {})
        .sort()
        .join(","),
      model: params.model ?? "",
      betas: (params.betas ?? []) as string[],
    });
  }

  // Merge caller-provided hooks (registry PreToolUse/PostToolUse) with the
  // opt-in tool-result dedup PostToolUse hook.
  const hooks = mergeHooks(params.hooks, buildDedupHooks());

  return query({
    prompt: params.prompt,
    options: {
      model: params.model,
      // A.2 — fallback model(s). The SDK option is a SINGLE comma-separated string
      // (tried in order, primary re-tried each turn), not an array.
      ...(params.fallbackModels?.length ? { fallbackModel: params.fallbackModels.join(",") } : {}),
      permissionMode: params.permissionMode ?? "acceptEdits",
      systemPrompt,
      // A.3 — hermetic runtime: do not load filesystem `.claude/` settings (agents,
      // hooks, skills, `.mcp.json`, memory). Nomos is DB-backed and self-reimplements
      // its config, so cwd `.claude/` must not leak in. Re-opt into project settings
      // only via NOMOS_SETTING_SOURCES=project.
      settingSources: process.env.NOMOS_SETTING_SOURCES === "project" ? ["project"] : [],
      mcpServers: params.mcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      thinking: params.thinking ?? { type: "adaptive" },
      resume: params.resume,
      maxTurns: params.maxTurns ?? 50,
      maxBudgetUsd: params.maxBudgetUsd,
      ...(params.outputFormat ? { outputFormat: params.outputFormat } : {}),
      persistSession: params.persistSession ?? true,
      enableFileCheckpointing: params.enableFileCheckpointing ?? true,
      ...(params.abortController ? { abortController: params.abortController } : {}),
      includePartialMessages: true,
      sandbox: params.sandbox,
      betas: params.betas,
      debug: params.debug,
      stderr: params.stderr,
      plugins: params.plugins,
      env,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.onElicitation ? { onElicitation: params.onElicitation } : {}),
      ...(hooks ? { hooks } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
    },
  });
}
