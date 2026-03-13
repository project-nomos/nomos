import {
  query,
  type Query,
  type Options,
  type McpServerConfig,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type { Query, SDKMessage, SDKResultMessage, McpServerConfig };

export interface RunSessionParams {
  /** The user prompt to send */
  prompt: string;
  /** Claude model to use */
  model?: string;
  /** Text appended to Claude Code's default system prompt */
  systemPromptAppend?: string;
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
}

/**
 * Wraps the Claude Agent SDK `query()` call.
 * Returns the async generator of SDK messages.
 */
export function runSession(params: RunSessionParams): Query {
  return query({
    prompt: params.prompt,
    options: {
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
      allowedTools: params.allowedTools,
      thinking: params.thinking ?? { type: "adaptive" },
      resume: params.resume,
      maxTurns: params.maxTurns ?? 50,
      maxBudgetUsd: params.maxBudgetUsd,
      persistSession: true,
      enableFileCheckpointing: true,
      includePartialMessages: true,
      sandbox: params.sandbox,
      betas: params.betas,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "nomos/0.1.0",
      },
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
