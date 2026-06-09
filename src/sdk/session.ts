import {
  query,
  type Query,
  type Options,
  type McpServerConfig,
  type SDKMessage,
  type SDKResultMessage,
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
  McpServerConfig,
  SdkPluginConfig,
  OnElicitation,
};

export interface RunSessionParams {
  /** The user prompt to send */
  prompt: string;
  /** Claude model to use */
  model?: string;
  /** Text appended to Claude Code's default system prompt */
  systemPromptAppend?: string;
  /** Full system prompt override (takes precedence over systemPromptAppend) */
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
  /** Sandbox settings */
  sandbox?: {
    enabled: boolean;
    autoAllowBashIfSandboxed?: boolean;
    network?: { allowedDomains?: string[] };
  };
  /** SDK betas to enable */
  betas?: Options["betas"];
  /** Fallback models to try if primary model fails */
  fallbackModels?: string[];
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
  // Build system prompt config
  let systemPrompt: Options["systemPrompt"];
  if (params.systemPrompt) {
    systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: params.systemPrompt,
    };
  } else if (params.systemPromptAppend) {
    systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: params.systemPromptAppend,
    };
  } else {
    systemPrompt = { type: "preset", preset: "claude_code" };
  }

  // Build env, including custom base URL if provided.
  // Remove CLAUDECODE so the SDK subprocess doesn't think it's nested inside Claude Code.
  // Must delete the key entirely -- setting to undefined leaves it as "" in the child process.
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "nomos/0.1.0",
  };
  delete env.CLAUDECODE;

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
      permissionMode: params.permissionMode ?? "acceptEdits",
      systemPrompt,
      mcpServers: params.mcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      thinking: params.thinking ?? { type: "adaptive" },
      resume: params.resume,
      maxTurns: params.maxTurns ?? 50,
      maxBudgetUsd: params.maxBudgetUsd,
      persistSession: true,
      enableFileCheckpointing: true,
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
    },
  });
}

/**
 * V2 SDK Session interface with typed methods.
 */
export interface V2Session {
  /** Send a prompt and get streaming response */
  send(prompt: string): AsyncIterable<SDKMessage>;
  /** Stream messages from the session */
  stream(): AsyncIterable<SDKMessage>;
  /** Close the session */
  close(): Promise<void>;
}

/**
 * Check if V2 SDK session API is available.
 * Returns false if the SDK doesn't export all required V2 functions.
 */
export function isV2Available(): boolean {
  try {
    // Dynamic check — V2 API may not exist in installed SDK version
    const sdk = require("@anthropic-ai/claude-agent-sdk");
    return (
      typeof sdk.unstable_v2_createSession === "function" &&
      typeof sdk.unstable_v2_resumeSession === "function" &&
      typeof sdk.unstable_v2_prompt === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Create a V2 SDK session (if available).
 * Returns null if V2 is not available.
 *
 * Note: The following V1 options are not yet supported in V2:
 * - maxBudgetUsd
 * - enableFileCheckpointing
 * - env
 */
export async function createV2Session(params: RunSessionParams): Promise<V2Session | null> {
  if (!isV2Available()) return null;

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const createSession = (sdk as Record<string, unknown>).unstable_v2_createSession as (
      opts: Record<string, unknown>,
    ) => V2Session;
    const resumeSession = (sdk as Record<string, unknown>).unstable_v2_resumeSession as (
      sessionId: string,
    ) => V2Session;

    if (typeof createSession !== "function" || typeof resumeSession !== "function") {
      return null;
    }

    // Handle resume case
    if (params.resume) {
      return resumeSession(params.resume);
    }

    // Create new session
    return createSession({
      model: params.model,
      permissionMode: params.permissionMode ?? "acceptEdits",
      systemPrompt: params.systemPromptAppend
        ? {
            type: "preset",
            preset: "claude_code",
            append: params.systemPromptAppend,
          }
        : { type: "preset", preset: "claude_code" },
      mcpServers: params.mcpServers,
      thinking: params.thinking ?? { type: "adaptive" },
      maxTurns: params.maxTurns ?? 50,
      sandbox: params.sandbox,
      betas: params.betas,
    });
  } catch {
    return null;
  }
}

/**
 * Run a one-shot V2 prompt without creating a session.
 * Returns null if V2 is not available.
 *
 * Note: The following V1 options are not yet supported in V2:
 * - maxBudgetUsd
 * - enableFileCheckpointing
 * - env
 */
export async function runV2Prompt(
  params: RunSessionParams,
): Promise<AsyncIterable<SDKMessage> | null> {
  if (!isV2Available()) return null;

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const prompt = (sdk as Record<string, unknown>).unstable_v2_prompt as (
      promptText: string,
      opts: Record<string, unknown>,
    ) => AsyncIterable<SDKMessage>;

    if (typeof prompt !== "function") return null;

    return prompt(params.prompt, {
      model: params.model,
      permissionMode: params.permissionMode ?? "acceptEdits",
      systemPrompt: params.systemPromptAppend
        ? {
            type: "preset",
            preset: "claude_code",
            append: params.systemPromptAppend,
          }
        : { type: "preset", preset: "claude_code" },
      mcpServers: params.mcpServers,
      thinking: params.thinking ?? { type: "adaptive" },
      maxTurns: params.maxTurns ?? 50,
      sandbox: params.sandbox,
      betas: params.betas,
    });
  } catch {
    return null;
  }
}
