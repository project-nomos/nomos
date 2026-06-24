/**
 * Centralized agent runtime for the daemon.
 *
 * Loads config, identity, profile, skills, and MCP once at startup (cached).
 * Processes messages through the Claude Agent SDK via `runSession()`.
 * Manages SDK session IDs backed by the DB sessions table.
 */

import {
  runSession,
  type McpServerConfig,
  type RunSessionParams,
  type SDKMessage,
  type SdkPluginConfig,
} from "../sdk/session.ts";
import { LiveSessionManager, type LiveTurnState } from "./live-session.ts";
import { AssistantText } from "./assistant-text.ts";
import type { ElicitationManager, ElicitationSource } from "./elicitation-manager.ts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { buildSdkHooks } from "../hooks/sdk-adapter.ts";
import { loadInstalledPlugins, toSdkPluginConfigs } from "../plugins/loader.ts";
import { ensureDefaultPlugins } from "../plugins/installer.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { getCostTracker } from "../sdk/cost-tracker.ts";
import {
  buildNativeAgents,
  nativeAgentsEnabled,
  useNativeTeam,
  stripTeamPrefix,
} from "../sdk/agents.ts";
import {
  isDiscordConfigured,
  createDiscordMcpServer,
  loadDiscordTokenFromDb,
} from "../sdk/discord-mcp.ts";
import {
  isTelegramConfigured,
  createTelegramMcpServer,
  loadTelegramTokenFromDb,
} from "../sdk/telegram-mcp.ts";
import { isGoogleWorkspaceConfiguredAsync } from "../sdk/google-workspace-mcp.ts";
import { buildGoogleMcpServers, buildGoogleIntegrationPrompt } from "../sdk/google-mcp.ts";
import { buildClassroomMcpServer } from "../sdk/google-classroom-mcp.ts";
import { hasClassroomWriteScope, listGoogleAccounts } from "../auth/google-integration.ts";
import { buildStudioMcpServer } from "../sdk/studio-mcp.ts";
import { buildVaultMcpServer } from "../sdk/vault-mcp.ts";
import { buildNativeDeviceMcpServer } from "../sdk/native-device-mcp.ts";
import { getDeviceBridge } from "./device-bridge.ts";
import { buildThinkMcpServer } from "../sdk/think-mcp.ts";
import { buildLoopMcpServer } from "../sdk/loop-mcp.ts";
import { buildMemoryDigest } from "../memory/digest.ts";
import { captureMoodFromTurn } from "../memory/mood-log.ts";
import { getRelevantArticles } from "../memory/wiki-reader.ts";
import { loadEnvConfig, type NomosConfig } from "../config/env.ts";
import { FEATURES, isHosted } from "../config/mode.ts";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";

/**
 * Built-in tools blocked when hosted-mode feature gates demand it. Centralized
 * here so both single-agent and team-runtime call sites stay consistent.
 */
function getDisallowedTools(): string[] {
  // Block the SDK's generic orchestration/task built-ins so the agent routes to the
  // Nomos-native equivalents (which render proper cards + own durable state):
  //  - `Workflow` spawns sub-agents outside our control + leaks a raw script →
  //    the model delegates via the native `Agent` tool (team mode) instead.
  //  - The SDK async task tracker (`Task`/`TaskCreate`/`TaskStop`/…) is NOT registered
  //    in our sessions (CLAUDE_CODE_ENABLE_TASKS is off), so we don't deny it — denying
  //    an unregistered tool only emits a "matches no known tool" warning. If the SDK's
  //    default ever flips tasks on, re-add the registered names here.
  //  - `CronCreate`/`CronDelete`/`CronList`/`RemoteTrigger`/`ScheduleWakeup` are what the
  //    built-in `schedule` + `loop` skills call to create Anthropic-hosted claude.ai
  //    Routines (1-hour minimum, results land on the claude.ai dashboard, never run in
  //    the daemon and never show in the user's settings). A prompt warning alone didn't
  //    stop the agent from reaching for them, so block them outright → the agent must use
  //    the `schedule_task` / `loop_create` MCP tools, which run locally in the daemon.
  // NOTE: `AskUserQuestion` (the SDK's native ask tool) is NOT blocked — it's the agent's
  // ONLY way to ask the user, routed through the ElicitationManager → the Ask card by the
  // `canUseTool` handler in runAgent (Phase F; the hand-rolled `ask_user` MCP tool is gone).
  const blocked: string[] = [
    "Workflow",
    "CronCreate",
    "CronDelete",
    "CronList",
    "RemoteTrigger",
    "ScheduleWakeup",
    // D.1 — scoped Bash deny rules for the unambiguous CRITICAL patterns (mirrors
    // the critical entries in security/tool-approval.ts). These are declarative
    // defense-in-depth: honored even under bypassPermissions, and they survive even
    // if the block_critical PreToolUse hook is ever misconfigured. The AST hook
    // remains the primary, more-precise gate; these never block legitimate work.
    ...CRITICAL_BASH_DENY,
  ];
  if (!FEATURES.bashTool()) {
    blocked.push("Bash", "BashOutput", "KillBash");
  }
  return blocked;
}

/**
 * Scoped Bash deny specifiers (Claude Code `Bash(prefix:*)` form) for the
 * irrecoverable, unambiguous operations. Kept conservative on purpose — only
 * commands with no legitimate agent use — so the rules never false-positive.
 */
const CRITICAL_BASH_DENY: string[] = [
  "Bash(rm -rf:*)",
  "Bash(rm -fr:*)",
  "Bash(mkfs:*)",
  "Bash(mkfs.*:*)",
  "Bash(dd if=:*)",
  "Bash(shutdown:*)",
  "Bash(reboot:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
];

/** Human "N minutes/hours/days/months" since `date`. "" when under ~10 min (too recent to anchor). */
function formatElapsedSince(date: Date): string {
  const min = Math.floor((Date.now() - date.getTime()) / 60000);
  if (min < 10) return "";
  if (min < 60) return `${min} minutes`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"}`;
}

/**
 * Tools that must NOT surface as a generic tool-use card. Either they have a
 * dedicated card (AskUserQuestion → the Ask card) or they're internal plumbing
 * the agent uses to set itself up, not an action taken for the user: ToolSearch
 * loads tool schemas on demand, List/ReadMcpResource discover MCP resources, and
 * Skill loads a playbook into context. Showing these as "tools" is just noise
 * (and a Skill rendered with a wrench + DONE reads as if work was done).
 */
const SILENT_TOOLS = new Set<string>([
  "AskUserQuestion",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "Skill",
]);

/** Whether a tool call should be hidden from the tool-use activity stream. */
export function isSilentTool(name: string): boolean {
  return SILENT_TOOLS.has(name);
}

/** A short, human one-liner describing a tool call, derived from its input. */
function summarizeToolInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (name) {
    case "WebSearch":
      return str(o.query);
    case "WebFetch":
      return str(o.url);
    case "Read":
    case "Edit":
    case "Write":
      return str(o.file_path);
    case "Bash":
      return str(o.command);
    case "Grep":
    case "Glob":
      return str(o.pattern);
    case "Skill":
      return str(o.skill) || str(o.name) || str(o.command);
    default: {
      // A friendly summary from a known field. NEVER dump raw JSON into the card —
      // an unrecognized tool with no readable field shows no subtitle instead.
      return (
        str(o.query) ||
        str(o.prompt) ||
        str(o.path) ||
        str(o.message) ||
        str(o.description) ||
        str(o.skill) ||
        str(o.name) ||
        str(o.command) ||
        str(o.url) ||
        str(o.content) ||
        str(o.title) ||
        ""
      );
    }
  }
}

/** Convert a TodoWrite tool input into a `plan` event for clients (PlanCard). */
function todoWriteToPlan(input: unknown): Extract<AgentEvent, { type: "plan" }> | null {
  const todos = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const items = todos.map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const status = typeof o.status === "string" ? o.status : "pending";
    const state = status === "completed" ? "done" : status === "in_progress" ? "active" : "todo";
    const content = typeof o.content === "string" ? o.content : "";
    const activeForm = typeof o.activeForm === "string" ? o.activeForm : undefined;
    return { title: content, sub: state === "active" ? activeForm : undefined, state } as const;
  });
  return { type: "plan", title: "Plan", items };
}
import { classifyQuery } from "../routing/classifier.ts";
import {
  loadUserProfile,
  loadAgentIdentity,
  buildSystemPromptAppend,
  buildRuntimeInfo,
  type UserProfile,
  type AgentIdentity,
} from "../config/profile.ts";
import { loadSoulFile, loadSoulFromDb, DEFAULT_SOUL } from "../config/soul.ts";
import { loadToolsFile } from "../config/tools-md.ts";
import { loadIdentityFile } from "../config/identity.ts";
import { loadAgentConfigs, getActiveAgent } from "../config/agents.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";
import { loadMcpConfig } from "../cli/mcp-config.ts";
import { createSession as createDbSession, getSessionByKey } from "../db/sessions.ts";
import { appendTranscriptMessage } from "../db/transcripts.ts";
import { isEphemeralSession } from "./memory-indexer.ts";
import { runMigrations } from "../db/migrate.ts";
import { hydrateApiKeysFromIntegrations } from "../config/api-keys.ts";
import type { IncomingMessage, OutgoingMessage, AgentEvent } from "./types.ts";
import { TheoryOfMindTracker } from "../memory/theory-of-mind.ts";
import {
  loadPersonas,
  detectPersona,
  buildPersonaPrompt,
  type Persona,
} from "../config/personas.ts";
import { ShadowObserver } from "../memory/shadow-observer.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("agent-runtime");

/**
 * F — build the `canUseTool` permission callback. The SDK invokes it for the
 * native `AskUserQuestion` tool (which fires even under bypassPermissions, proven
 * by eval/canusetool-bypass-harness.ts). We route each question through the SAME
 * elicitation pipeline as the MCP `ask_user` tool, so model-driven asks render on
 * the Ask card (one card with 1-4 questions) across Slack / mobile / iOS.
 * multiSelect answers come back as a label[] array. All other tools pass through.
 */
export function buildAskCanUseTool(
  mgr: ElicitationManager,
  source: ElicitationSource,
): NonNullable<Options["canUseTool"]> {
  return async (toolName, input, opts) => {
    if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
    const questions =
      (input.questions as Array<{
        question: string;
        header?: string;
        multiSelect?: boolean;
        options?: Array<{ label: string; description?: string }>;
      }>) ?? [];
    const valid = questions.filter((q) => (q.options ?? []).some((o) => o.label));
    if (valid.length === 0) return { behavior: "allow", updatedInput: input };

    // ONE card for all questions (F multi-question). Each question is answered via
    // the existing per-question AnswerQuestion RPC; we resolve when all are in.
    const picked = await mgr.askQuestionSet(
      valid.map((q) => ({
        prompt: q.question,
        header: q.header,
        multiSelect: q.multiSelect,
        options: (q.options ?? []).filter((o) => o.label),
      })),
      source,
      opts.signal,
    );

    // multiSelect questions MUST return an array of labels (label[]); a single
    // joined string reads as "no matching option" and the model re-asks forever.
    const answers: Record<string, string | string[]> = {};
    valid.forEach((q, i) => {
      const a = picked[i];
      if (!a) return;
      answers[q.question] = q.multiSelect
        ? a
            .split(/\s*,\s*/)
            .map((s) => s.trim())
            .filter(Boolean)
        : a;
    });
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };
}

/** Shown when a turn stops because it hit NOMOS_TURN_BUDGET_USD (B.1). */
const BUDGET_CAP_NOTICE =
  "I reached the per-turn spending cap before finishing this. Reply to have me continue where I left off.";

/**
 * E — OS-level Bash sandbox for the power-user box. Opt-in via NOMOS_SANDBOX=true:
 * the personal-machine threat model (untrusted Slack/email/iMessage input +
 * bypassPermissions + no container) is the strongest case, but enabling a sandbox
 * can break legitimate file/network work, so it is off by default and the operator
 * turns it on deliberately. Hosted already has container isolation → skipped there.
 * Scoped permissively (a domain allowlist that covers normal agent work);
 * failIfUnavailable:false degrades gracefully on a host without the OS primitives;
 * allowAppleEvents keeps `open`/`osascript`/browser-auth working on macOS.
 */
const DEFAULT_SANDBOX_DOMAINS = [
  "api.anthropic.com",
  "*.anthropic.com",
  "*.googleapis.com",
  "*.google.com",
  "github.com",
  "*.github.com",
  "registry.npmjs.org",
];
function buildSandboxConfig(): RunSessionParams["sandbox"] | undefined {
  if (process.env.NOMOS_SANDBOX !== "true" || isHosted()) return undefined;
  const domains = process.env.NOMOS_SANDBOX_DOMAINS
    ? process.env.NOMOS_SANDBOX_DOMAINS.split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : DEFAULT_SANDBOX_DOMAINS;
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowAppleEvents: true,
    network: { allowedDomains: domains },
  };
}

/**
 * B.3 — feed an SDK result message's per-model usage (incl. cache read/creation
 * + web-search) into the global CostTracker. The bare `total_cost_usd → DB` write
 * loses the per-model split and the prompt-cache hit rate; `result.modelUsage`
 * (required on the result message) carries both. Safe no-op when absent. Called
 * from BOTH the one-shot drain and the Layer-A live drain.
 */
function accrueModelUsage(msg: unknown): void {
  const mu = (
    msg as {
      modelUsage?: Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          webSearchRequests?: number;
        }
      >;
    }
  ).modelUsage;
  if (!mu) return;
  const tracker = getCostTracker();
  for (const [model, u] of Object.entries(mu)) {
    tracker.addTurn(model, {
      input_tokens: u.inputTokens ?? 0,
      output_tokens: u.outputTokens ?? 0,
      cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
      server_tool_use: { web_search_requests: u.webSearchRequests ?? 0 },
    });
  }
}

export class AgentRuntime {
  // Cached at startup
  private plugins: SdkPluginConfig[] = [];
  private config!: NomosConfig;
  private profile!: UserProfile;
  private identity!: AgentIdentity;
  private systemPromptAppend!: string;
  private mcpServers!: Record<string, McpServerConfig>;
  /** Held-open streaming sessions (Layer A) when NOMOS_LIVE_SESSIONS=true; else undefined. */
  private liveSessions?: LiveSessionManager;

  // SDK session ID cache: sessionKey → SDK session ID
  private sdkSessionIds = new Map<string, string>();
  /** D.2 — per-session AbortController for the in-flight one-shot turn (cancellation). */
  private turnAborts = new Map<string, AbortController>();

  // Per-session Theory of Mind trackers (transient, session-scoped)
  private tomTrackers = new Map<string, TheoryOfMindTracker>();

  // Cached personas for contextual identity switching
  private personas: Persona[] = [];

  // Shadow Mode observer for passive behavioral learning
  private shadowObserver?: ShadowObserver;

  // Google Workspace authorized accounts
  private gwsAccounts?: Array<{ email: string; isDefault: boolean }>;
  private slackWorkspaces?: Array<{ teamId: string; teamName: string; userId: string }>;
  private notificationDefault?: { platform: string; channelId: string; label?: string };

  // Optional elicitation manager (set by gateway). When present, the SDK's
  // `onElicitation` callback routes ask_user requests through it.
  private elicitationManager?: import("./elicitation-manager.ts").ElicitationManager;

  // Optional draft manager (set by gateway). Used by the Classroom tools to stage
  // homework submissions as accept/edit/decline drafts.
  private draftManager?: import("./draft-manager.ts").DraftManager;

  private initialized = false;

  /** Wire in the elicitation manager. Called by the gateway after construction. */
  setElicitationManager(mgr: import("./elicitation-manager.ts").ElicitationManager): void {
    this.elicitationManager = mgr;
  }

  /** Wire in the draft manager. Called by the gateway after construction. */
  setDraftManager(mgr: import("./draft-manager.ts").DraftManager): void {
    this.draftManager = mgr;
  }

  /**
   * Stage a Classroom homework submission as a DraftManager draft (accept / edit /
   * decline). The actual attach + turn-in runs in the approve handler on approval.
   * Returns null when no draft manager is wired (e.g. CLI in-process mode).
   */
  private async createClassroomDraft(args: {
    userId: string;
    courseId: string;
    courseWorkId: string;
    submissionId: string;
    title: string;
    body: string;
    attachAs: "doc" | "link";
    link?: string;
    account?: string;
    courseName?: string;
    assignmentTitle?: string;
  }): Promise<{ draftId: string } | null> {
    if (!this.draftManager) return null;
    const draft = await this.draftManager.createDraft(
      {
        platform: "classroom",
        channelId: args.courseId,
        inReplyTo: args.courseWorkId,
        content: args.body,
      },
      args.userId,
      {
        kind: "classroom_submission",
        courseId: args.courseId,
        courseWorkId: args.courseWorkId,
        submissionId: args.submissionId,
        attachAs: args.attachAs,
        title: args.title,
        link: args.link,
        account: args.account,
        courseName: args.courseName,
        assignmentTitle: args.assignmentTitle,
      },
    );
    return draft ? { draftId: draft.id } : null;
  }

  /** Expose the elicitation manager so channel adapters can resolve answers. */
  getElicitationManager(): import("./elicitation-manager.ts").ElicitationManager | undefined {
    return this.elicitationManager;
  }

  /** Get the configured model name. */
  getModel(): string {
    return this.config?.model ?? "claude-sonnet-4-6";
  }

  /** Reload per-workspace Slack MCP servers from DB (called by gateway on workspace changes). */
  async reloadSlackWorkspaceMcps(): Promise<void> {
    try {
      const { createPerWorkspaceSlackMcpServers } = await import("../sdk/slack-workspace-mcp.ts");
      const { listWorkspaces } = await import("../db/slack-workspaces.ts");

      // Remove old workspace MCP servers
      for (const key of Object.keys(this.mcpServers)) {
        if (key.startsWith("slack-ws-")) {
          delete this.mcpServers[key];
        }
      }

      // Add current ones from DB
      const wsServers = await createPerWorkspaceSlackMcpServers();
      Object.assign(this.mcpServers, wsServers);

      const workspaces = await listWorkspaces();
      this.slackWorkspaces = workspaces.map((ws) => ({
        teamId: ws.team_id,
        teamName: ws.team_name,
        userId: ws.user_id,
      }));

      log.info(`Reloaded ${Object.keys(wsServers).length} workspace MCP server(s)`);
    } catch (err) {
      log.error({ err }, "Failed to reload workspace MCPs");
    }
  }

  /** Initialize the runtime: run migrations, load all config. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Run DB migrations. On a fresh install the database doesn't exist yet,
    // so we degrade gracefully — the Settings UI's setup wizard creates it
    // on first run. Anything that touches the DB at runtime will surface
    // its own error if the DB is still missing.
    try {
      await runMigrations();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `DB migrations skipped (${msg}). Continuing without DB so the setup wizard can configure it.`,
      );
    }

    // Bridge the Settings-UI Google AI key (stored encrypted in the `google-ai`
    // integration) into process.env so embeddings + Studio gen can read
    // GOOGLE_API_KEY. Runs after migrations (DB ready), before any embedding use.
    await hydrateApiKeysFromIntegrations();

    // Load config
    this.config = loadEnvConfig();

    // Apply agent config overrides
    const agentConfigs = loadAgentConfigs();
    const activeAgent = getActiveAgent(agentConfigs);
    if (activeAgent.model) {
      this.config.model = activeAgent.model;
    }

    // Load personalization
    [this.profile, this.identity] = await Promise.all([loadUserProfile(), loadAgentIdentity()]);

    // Override identity with IDENTITY.md if present (file > DB)
    const fileIdentity = loadIdentityFile();
    if (fileIdentity) {
      if (fileIdentity.name) this.identity.name = fileIdentity.name;
      if (fileIdentity.emoji) this.identity.emoji = fileIdentity.emoji;
      if (fileIdentity.purpose) this.identity.purpose = fileIdentity.purpose;
    }

    // Load skills
    const skills = loadSkills();
    const skillsPrompt = formatSkillsForPrompt(skills);

    // Load plugins (ensure defaults are installed on first run)
    const newlyInstalled = await ensureDefaultPlugins();
    if (newlyInstalled.length > 0) {
      log.info(
        `Pre-installed ${newlyInstalled.length} default plugin(s): ${newlyInstalled.join(", ")}`,
      );
    }
    const loadedPlugins = await loadInstalledPlugins();
    this.plugins = toSdkPluginConfigs(loadedPlugins);

    // Load personality (file > DB > bundled default)
    const soulPrompt = loadSoulFile() ?? (await loadSoulFromDb()) ?? DEFAULT_SOUL;

    // Load environment config
    const toolsPrompt = loadToolsFile();

    // Build runtime info
    const runtimeInfo = buildRuntimeInfo();

    // Build MCP servers (before system prompt so integrations summary can inspect them)
    this.mcpServers = {};
    const mcpConfig = await loadMcpConfig();
    if (mcpConfig) {
      for (const [name, serverConfig] of Object.entries(mcpConfig)) {
        this.mcpServers[name] = serverConfig as McpServerConfig;
      }
    }
    this.mcpServers["nomos-memory"] = createMemoryMcpServer();
    // "Think Like You" tools: bridge reflect/calibrate/dna skills to their backends.
    this.mcpServers["nomos-think"] = buildThinkMcpServer();

    // Layer A: hold streaming sessions open so turns (and background-task resumes)
    // continue in-process, in-context, zero-warmup. Opt-in; the one-shot path is
    // the default. The manager drives the loop and calls back into the shared
    // SDK-message handler so there is one drain implementation.
    if (process.env.NOMOS_LIVE_SESSIONS === "true") {
      this.liveSessions = new LiveSessionManager((msg, emit, state, sessionKey) =>
        this.handleSdkMessage(msg, emit, state, sessionKey),
      );
      log.info("Live streaming sessions enabled (NOMOS_LIVE_SESSIONS=true)");
    }

    // Pre-load DB-backed tokens for integrations that use sync getters
    await Promise.all([loadDiscordTokenFromDb(), loadTelegramTokenFromDb()]);

    // Per-workspace Slack MCP servers (in-process, one per connected workspace)
    try {
      const { createPerWorkspaceSlackMcpServers } = await import("../sdk/slack-workspace-mcp.ts");
      const { listWorkspaces } = await import("../db/slack-workspaces.ts");
      const wsServers = await createPerWorkspaceSlackMcpServers();
      Object.assign(this.mcpServers, wsServers);
      const workspaces = await listWorkspaces();
      if (workspaces.length > 0) {
        this.slackWorkspaces = workspaces.map((ws) => ({
          teamId: ws.team_id,
          teamName: ws.team_name,
          userId: ws.user_id,
        }));
      }
    } catch {
      // No workspaces configured — skip
    }

    if (isDiscordConfigured()) {
      this.mcpServers["nomos-discord"] = createDiscordMcpServer();
    }
    if (isTelegramConfigured()) {
      this.mcpServers["nomos-telegram"] = createTelegramMcpServer();
    }
    if (await isGoogleWorkspaceConfiguredAsync()) {
      // Register the in-process Google Workspace MCP (gmail_*, calendar_*,
      // etc.). Tools shell out to the `gws` CLI under the hood with the
      // right per-account `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, so the agent
      // gets typed tools and native multi-account in one server.
      try {
        const { createGoogleWorkspaceMcpServer } = await import("../sdk/google-workspace-mcp.ts");
        this.mcpServers["nomos-google-workspace"] = createGoogleWorkspaceMcpServer();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "Failed to register google-workspace MCP",
        );
      }

      // Load authorized accounts for the system prompt.
      try {
        const { syncGoogleAccountsFromGws } = await import("../db/google-accounts.ts");
        const accounts = await syncGoogleAccountsFromGws();
        this.gwsAccounts = accounts.map((a) => ({
          email: a.email,
          isDefault: a.is_default,
        }));
      } catch {
        // Fall back to gws CLI directly
        try {
          const { listGwsAccounts } = await import("../sdk/google-workspace-mcp.ts");
          const { accounts } = await listGwsAccounts();
          this.gwsAccounts = accounts.map((a) => ({
            email: typeof a === "string" ? a : a.email,
            isDefault: typeof a === "string" ? false : a.default,
          }));
        } catch {
          // Could not list accounts
        }
      }
    }

    // Load stored permissions for system prompt
    let permissionsSummary: string | undefined;
    try {
      const { listPermissions } = await import("../db/permissions.ts");
      const perms = await listPermissions();
      if (perms.length > 0) {
        permissionsSummary = perms
          .map((p) => `- ${p.resource_type}/${p.action} → ${p.pattern}`)
          .join("\n");
      }
    } catch {
      // Permissions table may not exist yet on first run — skip
    }

    // Load user model + exemplars for adaptive behavior, baked into the cached
    // system prompt. This runs once at init with no per-turn user, so it is only
    // correct for the single-owner power-user install. In hosted (multi-tenant)
    // the per-turn `buildMemoryDigest` injects the right user's model+profile, so
    // we skip the stale init-time load rather than bake one tenant's data into
    // everyone's prompt.
    let userModel: import("../db/user-model.ts").UserModelEntry[] | undefined;
    let exemplars: import("../config/profile.ts").ExemplarEntry[] | undefined;
    if (this.config.adaptiveMemory && !isHosted()) {
      try {
        const { getUserModel } = await import("../db/user-model.ts");
        userModel = await getUserModel(resolveMemoryUserId(undefined));
      } catch {
        // Table may not exist yet -- skip
      }

      // Load exemplars for few-shot personality priming
      try {
        const { retrieveExemplars } = await import("../memory/exemplars.ts");
        const stored = await retrieveExemplars(
          resolveMemoryUserId(undefined),
          "general conversation",
          undefined,
          3,
        );
        if (stored.length > 0) {
          exemplars = stored.map((e) => ({
            text: e.text,
            context: e.context,
            platform: e.platform,
          }));
        }
      } catch {
        // Exemplar table may not exist yet -- skip
      }
    }

    // Load personas for contextual identity switching
    try {
      this.personas = await loadPersonas();
    } catch {
      // Config table may not exist yet
    }

    // Load notification default for system prompt
    try {
      const { getNotificationDefault } = await import("../db/notification-defaults.ts");
      const nd = await getNotificationDefault();
      if (nd) this.notificationDefault = nd;
    } catch {
      // Config table may not exist yet
    }

    // Check iMessage/Messages.app integration from DB
    if (process.platform === "darwin" && !this.imessageEnabled) {
      try {
        const { getIntegration } = await import("../db/integrations.ts");
        const imsg = await getIntegration("imessage");
        if (imsg?.enabled) {
          const cfg = imsg.config as Record<string, unknown>;
          this.imessageEnabled = cfg.enabled === "true";
        }
      } catch {
        // DB not available
      }
    }

    // Build system prompt (after MCP servers so integrations summary is accurate)
    this.systemPromptAppend = buildSystemPromptAppend({
      profile: this.profile,
      identity: this.identity,
      skillsPrompt: skillsPrompt || undefined,
      soulPrompt: soulPrompt ?? undefined,
      toolsPrompt: toolsPrompt ?? undefined,
      runtimeInfo,
      agentPrompt: activeAgent.systemPrompt || undefined,
      integrations: this.buildIntegrationsSummary(),
      permissions: permissionsSummary,
      userModel,
      exemplars,
    });

    // Team mode uses the native SDK `agents` path exclusively (Phase G): both the
    // `/team` prefix and natural-language delegation route to the model's `Agent`
    // tool, whose subagents inherit this turn's permissions + hooks (structural
    // safety). The hand-rolled TeamRuntime was deleted.

    // Initialize shadow observer for passive behavioral learning
    if (this.config.shadowMode) {
      this.shadowObserver = new ShadowObserver(true);
      try {
        await this.shadowObserver.load();
      } catch {
        // No prior observations -- start fresh
      }
    }

    this.initialized = true;
    log.info("Initialized");
    log.info(`  Model: ${this.config.model}`);
    if (this.config.teamMode) {
      log.info(`  Team mode: enabled (max ${this.config.maxTeamWorkers} workers)`);
    }
    if (this.config.adaptiveMemory) {
      log.info(
        `  Adaptive memory: enabled${userModel?.length ? ` (${userModel.length} model entries)` : ""}`,
      );
    }
    if (this.config.shadowMode) {
      const stats = this.shadowObserver!.getStats();
      log.info(
        `  Shadow mode: enabled (${stats.tools} tool obs, ${stats.corrections} corrections)`,
      );
    }
    if (this.config.anthropicBaseUrl) {
      log.info(`  API base URL: ${this.config.anthropicBaseUrl}`);
    }
    log.info(`  Identity: ${this.identity.emoji ?? ""} ${this.identity.name}`);
    log.info(`  MCP servers: ${Object.keys(this.mcpServers).join(", ")}`);
    if (this.plugins.length > 0) {
      const pluginNames = this.plugins.map((p) => p.path.split("/").pop()).join(", ");
      log.info(`  Plugins: ${pluginNames}`);
    }
    if (this.personas.length > 0) {
      const personaNames = this.personas.filter((p) => p.enabled).map((p) => p.name);
      log.info(`  Personas: ${personaNames.join(", ")}`);
    }
  }

  /** Get the loaded config. */
  getConfig(): NomosConfig {
    return this.config;
  }

  /** Get the loaded identity. */
  getIdentity(): AgentIdentity {
    return this.identity;
  }

  /** Build a human-readable summary of active integrations for the system prompt. */
  private buildIntegrationsSummary(): string {
    const parts: string[] = [];

    // BYO messaging channels (Slack/Discord/Telegram/WhatsApp/iMessage) are a power-user
    // feature only. On a hosted deployment the daemon may physically have one configured
    // (e.g. a Mac with Messages.app), but a hosted tenant's only channel is the mobile app
    // (see mode.ts: "Channels are limited to what the central app supports"). Advertising
    // these in hosted mode makes the agent claim a multi-channel presence it does not have
    // for this tenant — so suppress them unless we are power-user.
    const showByoChannels = !isHosted();

    if (showByoChannels && this.slackWorkspaces && this.slackWorkspaces.length > 0) {
      const wsList = this.slackWorkspaces
        .map(
          (ws) =>
            `  - ${ws.teamName} (${ws.teamId}) — connected as user ${ws.userId}, tools via \`mcp__slack-ws-${ws.teamId}\``,
        )
        .join("\n");
      parts.push(
        [
          `- **Slack** (user token mode — messages appear as the user, no bot/app token needed):`,
          wsList,
          `  Available tools per workspace: \`slack_send_message\`, \`slack_read_channel\`, \`slack_read_thread\`, \`slack_list_channels\`, \`slack_search\`, \`slack_user_info\`, \`slack_react\`, \`slack_edit_message\`, \`slack_delete_message\`, \`slack_pin_message\`, \`slack_unpin_message\`, \`slack_list_pins\`, \`slack_upload_file\`.`,
          `  Use \`slack_user_info\` to look up display names when the user refers to people by name.`,
        ].join("\n"),
      );
    }
    if (showByoChannels && isDiscordConfigured()) {
      parts.push("- **Discord**: Send and receive messages via Discord bot");
    }
    if (showByoChannels && isTelegramConfigured()) {
      parts.push("- **Telegram**: Send and receive messages via Telegram bot");
    }
    if (!isHosted() && this.gwsAccounts && this.gwsAccounts.length > 0) {
      const accountList = this.gwsAccounts
        .map((a) => `  - ${a.email}${a.isDefault ? " (default)" : ""}`)
        .join("\n");
      parts.push(
        [
          `- **Google Workspace** (Gmail, Calendar, Drive) — authorized accounts:`,
          accountList,
          `  PREFER the typed in-process tools (more reliable than the CLI — use these first): \`gmail_search\`, \`gmail_get_message\`, \`gmail_get_thread\`, \`gmail_create_draft\`, \`gmail_send_draft\`, \`gmail_list_labels\`, \`calendar_list_events\`, \`calendar_get_event\`, \`calendar_create_event\`, \`calendar_update_event\`, \`calendar_delete_event\`, \`google_list_accounts\`. Pass an \`account\` arg to target a specific email — you do NOT need to "switch" accounts.`,
          `  Recurring events: \`calendar_create_event\` takes a \`recurrence\` arg (RRULE), e.g. \`["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]\` for a weekday focus block — create ONE recurring event, never one per day.`,
          `  Fallback only: for operations the typed tools don't cover, the \`gws\` CLI is on PATH via the Bash tool: \`npx @googleworkspace/cli <service> <resource> <method> --params '<JSON>'\` (\`npx @googleworkspace/cli schema <service.resource.method>\` shows params).`,
        ].join("\n"),
      );
    }

    // Check for WhatsApp
    if (showByoChannels && process.env.WHATSAPP_ENABLED === "true") {
      parts.push("- **WhatsApp**: Receive and respond to messages via WhatsApp");
    }
    // Check for Messages.app (macOS only)
    if (showByoChannels && this.isImessageEnabled()) {
      parts.push(
        "- **Messages.app (iMessage)**: Receive and respond to messages via Messages.app. You have access to the user's iMessage conversations.",
      );
    }

    // Notification default
    if (this.notificationDefault) {
      const nd = this.notificationDefault;
      parts.push(
        `- **Default notification channel**: ${nd.label ?? nd.channelId} (${nd.platform}/${nd.channelId}). When creating scheduled tasks with \`announce: true\`, this channel is used automatically if no explicit target is given.`,
      );
    } else if (isHosted()) {
      parts.push(
        '- **Nomos app** — this conversation IS the Nomos app, and it is your ONLY messaging channel. The user talks to you here, and you reach them in the same place: you can send push notifications to their phone and follow up or check in unprompted, even when the app is closed. When the user asks how the two of you keep in touch, the answer is simply: right here in the app, plus notifications. Do NOT describe this conversation as "Claude Code", a terminal, or a developer tool, do NOT claim to be on any other messaging channel (no iMessage, Slack, Telegram, WhatsApp, or Discord), and do NOT tell the user to "configure" or "set up" channels. (Non-channel tool integrations the user has connected, like Google, remain available when present.)',
      );
    } else {
      parts.push(
        "- **No default notification channel configured.** When creating scheduled tasks with `announce: true`, you must specify `platform` and `channel_id` explicitly, or ask the user to set a default in Settings.",
      );
    }

    if (parts.length === 0) {
      return "No channel integrations are currently active. Only memory search is available.";
    }

    return [
      "The following integrations are **active, authenticated, and ready to use right now**. You DO have access to these — do not tell the user they need to configure them:",
      ...parts,
      "",
      "Use these integrations proactively when they can help fulfill the user's request. You are the user's digital clone — act on their behalf across all connected channels.",
      "**Proactive mode**: Use `proactive_send` to notify the user about important events without being asked — urgent emails, build failures, monitoring alerts, or time-sensitive information.",
      "Use `schedule_task` to create recurring or timed background tasks. With `announce: true`, results are delivered to the default notification channel automatically.",
    ].join("\n");
  }

  /** Check if Messages.app (iMessage) is enabled via env var or DB integration. */
  private imessageEnabled: boolean | null = null;
  private isImessageEnabled(): boolean {
    if (process.platform !== "darwin") return false;
    if (process.env.IMESSAGE_ENABLED === "true") return true;
    return this.imessageEnabled ?? false;
  }

  /**
   * Process an incoming message through the agent.
   * Streams events via `emit` and returns the final response.
   */
  async processMessage(
    message: IncomingMessage,
    emit: (event: AgentEvent) => void,
  ): Promise<OutgoingMessage> {
    if (!this.initialized) {
      throw new Error("AgentRuntime not initialized — call initialize() first");
    }

    const sessionKey = `${message.platform}:${message.channelId}`;

    // Ensure DB session exists, owned by the resolved tenant so the per-user
    // GetMessages gate (sessions.user_id == ctx.userId) returns this user's history.
    await createDbSession({
      sessionKey,
      model: this.config.model,
      userId: resolveMemoryUserId(message.userId),
    });

    // Look up cached SDK session ID for resume
    let resumeId = this.sdkSessionIds.get(sessionKey);

    // Also check DB metadata for SDK session ID
    if (!resumeId) {
      const existingSession = await getSessionByKey(sessionKey);
      const sdkId = (existingSession?.metadata as Record<string, unknown>)?.sdkSessionId;
      if (typeof sdkId === "string") {
        resumeId = sdkId;
        this.sdkSessionIds.set(sessionKey, sdkId);
      }
    }

    // Smart model routing: classify query complexity and select model tier
    let model = this.config.model;
    if (this.config.smartRouting) {
      const classification = classifyQuery(message.content);
      model = this.config.modelTiers[classification.tier];
      // Persist the routed model so the sessions row reflects what actually ran
      // (createDbSession seeded the base config.model before classification).
      // Fire-and-forget, and only when it differs, to avoid a redundant write.
      if (model !== this.config.model) {
        import("../db/sessions.ts")
          .then(({ updateSessionModelByKey }) => updateSessionModelByKey(sessionKey, model))
          .catch(() => {});
      }
      log.info(
        `Smart routing: "${classification.tier}" (confidence: ${classification.confidence.toFixed(2)}) → ${model}`,
      );
      // Show routing decision in the chat
      const shortModel = model.replace("claude-", "");
      emit({
        type: "system",
        subtype: "routing",
        message: `Routed to ${shortModel} (${classification.tier})`,
      });
    }

    // Team mode trigger (/team prefix): strip the prefix so the agent sees the bare
    // task; the model delegates via the native `Agent` tool inside the normal loop
    // (native agents are enabled in runAgent), so ToM + memory + cost tracking apply.
    const teamTask = this.config.teamMode ? stripTeamPrefix(message.content) : null;
    if (teamTask) {
      message.content = teamTask;
    }

    // Shadow mode: record turn for response cadence tracking
    this.shadowObserver?.recordTurn();

    // Update Theory of Mind tracker for this session
    let tomTracker = this.tomTrackers.get(sessionKey);
    if (!tomTracker) {
      tomTracker = new TheoryOfMindTracker();
      this.tomTrackers.set(sessionKey, tomTracker);
    }
    const tomState = tomTracker.update(message.content);
    const userState = tomTracker.formatForPrompt();

    // Emotional presence: when the live read flags genuine strain this turn, capture a
    // mood EPISODE (its cause, not a standing state) for continuity. Fire-and-forget and
    // cost-bounded to strain turns; the live read above always wins for the moment.
    if (tomState.emotion === "stressed" || tomState.emotion === "frustrated") {
      void captureMoodFromTurn(
        resolveMemoryUserId(message.userId),
        message.content,
        tomState.summary,
      ).catch(() => {});
    }

    // Detect active persona for this message context
    const personaMatches =
      this.personas.length > 0
        ? detectPersona(this.personas, {
            platform: message.platform,
            channelId: message.channelId,
            userId: message.userId,
            content: message.content,
            timestamp: message.timestamp,
          })
        : [];
    const personaPrompt = buildPersonaPrompt(personaMatches);

    emit({
      type: "system",
      subtype: "status",
      message: "Processing...",
    });

    try {
      const result = await this.runAgent(
        message.content,
        resumeId,
        emit,
        model,
        sessionKey,
        userState,
        personaPrompt,
        {
          platform: message.platform,
          channelId: message.channelId,
          threadId: message.threadId,
        },
        message.userId,
      );

      // Cache the new SDK session ID, and persist it so the conversation resumes
      // across a daemon restart (B.2). The daemon already READS metadata.sdkSessionId
      // on resume; this is the missing write-back. Fire-and-forget, off-the-record
      // sessions excluded. Continuity-of-thread, not data loss (durable state = vault).
      if (result.sessionId) {
        this.sdkSessionIds.set(sessionKey, result.sessionId);
        if (!isEphemeralSession(sessionKey)) {
          const sdkId = result.sessionId;
          import("../db/sessions.ts")
            .then(({ updateSessionSdkId }) => updateSessionSdkId(sessionKey, sdkId))
            .catch(() => {});
        }
      }

      // Persist cost data to sessions table (fire-and-forget)
      if (result.costUsd || result.inputTokens || result.outputTokens) {
        import("../db/sessions.ts")
          .then(({ updateSessionCost }) =>
            updateSessionCost(
              sessionKey,
              result.costUsd ?? 0,
              result.inputTokens ?? 0,
              result.outputTokens ?? 0,
            ),
          )
          .catch(() => {});
      }

      // Persist the turn transcript (user + assistant) so MGetMessages and the
      // load_thread tool have history. Off-the-record (ephemeral) sessions skip it.
      if (!isEphemeralSession(sessionKey)) {
        void (async () => {
          const session = await getSessionByKey(sessionKey);
          if (!session) return;
          const uid = resolveMemoryUserId(message.userId);
          await appendTranscriptMessage({
            sessionId: session.id,
            userId: uid,
            role: "user",
            content: message.content,
          });
          await appendTranscriptMessage({
            sessionId: session.id,
            userId: uid,
            role: "assistant",
            content: result.text || "",
            usage: { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0 },
          });
        })().catch(() => {});
      }

      return {
        inReplyTo: message.id,
        platform: message.platform,
        channelId: message.channelId,
        threadId: message.threadId,
        content: result.text || "_(no response)_",
        sessionId: result.sessionId,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: errMsg },
        `SDK error (model: ${model ?? this.config.model}, resume: ${!!resumeId})`,
      );

      // If resume failed, retry without resume.
      // "exited with code 1" is a generic SDK crash that often indicates a corrupt/stale session.
      // "Prompt is too long" means the resumed session exceeded the model's context window.
      // "Autocompact is thrashing" means the base context is too large even after compaction.
      if (
        resumeId &&
        /session|conversation|exited with code|prompt is too long|autocompact/i.test(errMsg)
      ) {
        this.sdkSessionIds.delete(sessionKey);

        emit({
          type: "system",
          subtype: "status",
          message: "Session expired, starting fresh...",
        });

        try {
          const result = await this.runAgent(
            message.content,
            undefined,
            emit,
            model,
            sessionKey,
            userState,
            personaPrompt,
            {
              platform: message.platform,
              channelId: message.channelId,
              threadId: message.threadId,
            },
            message.userId,
          );

          if (result.sessionId) {
            this.sdkSessionIds.set(sessionKey, result.sessionId);
          }

          return {
            inReplyTo: message.id,
            platform: message.platform,
            channelId: message.channelId,
            threadId: message.threadId,
            content: result.text || "_(no response)_",
            sessionId: result.sessionId,
          };
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);

          // If fresh session also fails with context issues, upgrade to a larger model
          if (
            /prompt is too long|autocompact/i.test(retryMsg) &&
            model !== this.config.modelTiers.moderate
          ) {
            const upgradeModel = this.config.modelTiers.moderate;
            log.warn(`Context too large for ${model}, upgrading to ${upgradeModel}`);
            emit({
              type: "system",
              subtype: "status",
              message: `Upgrading to ${upgradeModel.replace("claude-", "")} (context too large)...`,
            });

            try {
              const upgraded = await this.runAgent(
                message.content,
                undefined,
                emit,
                upgradeModel,
                sessionKey,
                userState,
                personaPrompt,
                {
                  platform: message.platform,
                  channelId: message.channelId,
                  threadId: message.threadId,
                },
                message.userId,
              );
              if (upgraded.sessionId) {
                this.sdkSessionIds.set(sessionKey, upgraded.sessionId);
              }
              return {
                inReplyTo: message.id,
                platform: message.platform,
                channelId: message.channelId,
                threadId: message.threadId,
                content: upgraded.text || "_(no response)_",
                sessionId: upgraded.sessionId,
              };
            } catch (upgradeErr) {
              const upgradeMsg =
                upgradeErr instanceof Error ? upgradeErr.message : String(upgradeErr);
              emit({ type: "error", message: upgradeMsg });
              throw upgradeErr;
            }
          }

          emit({ type: "error", message: retryMsg });
          throw retryErr;
        }
      }

      emit({ type: "error", message: errMsg });
      throw err;
    }
  }

  /** Run the SDK agent and collect events. */
  /** Observability: how many turns a held-open live session processed for a key (0 if disabled). */
  liveSessionTurns(sessionKey: string): number {
    return this.liveSessions?.turnCount(sessionKey) ?? 0;
  }

  private async runAgent(
    prompt: string,
    resumeId: string | undefined,
    emit: (event: AgentEvent) => void,
    model?: string,
    sessionKey?: string,
    userState?: string,
    personaPrompt?: string,
    /**
     * Source channel of the incoming message — used so the elicitation
     * manager renders `ask_user` questions back on the user's active
     * channel. Optional so non-message runs (cron, internal) keep working.
     */
    source?: { platform: string; channelId: string; threadId?: string },
    /** BA user making this request — scopes per-user integrations (hosted). */
    userId?: string,
  ): Promise<{
    text: string;
    sessionId?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  }> {
    // In hosted mode, register the requesting user's Google MCP servers:
    // Google's official remote MCP (read/draft/calendar/drive) + our opt-in
    // Gmail send tool, per connected account with fresh tokens (or the direct-
    // REST backup via NOMOS_GOOGLE_BACKEND=rest). Power-user keeps the gws CLI.
    // Long-term memory (vault) tools, scoped to the vault owner. Both modes.
    // In power-user mode every channel is the same owner, so collapse the raw
    // channel sender id to the canonical local id (otherwise the vault fragments
    // per channel); in hosted mode this is the authenticated per-tenant user.
    const vaultUserId = resolveMemoryUserId(userId);
    // The agent asks the user via the native `AskUserQuestion` tool, routed through
    // the ElicitationManager by the `canUseTool` handler below (see runParams).
    const mgr = this.elicitationManager;
    let mcpServers = {
      ...this.mcpServers,
      "nomos-vault": buildVaultMcpServer(vaultUserId),
      // Rebuild the memory tools per-turn so memory_search is scoped to this
      // owner (the cached one at init has no user). Overrides the cached entry.
      "nomos-memory": createMemoryMcpServer(vaultUserId, {
        // Session context so `background_register` resumes THIS conversation when
        // its watched work (CI/deploy) settles. Absent for cron/internal runs.
        session:
          sessionKey && source
            ? {
                sessionKey,
                platform: source.platform,
                channelId: source.channelId,
                userId: userId ?? vaultUserId,
              }
            : undefined,
      }),
      // Loop self-management, scoped to this owner so loops the agent creates are
      // owned by (and auditable by) the right user. The cron engine runs in this
      // process; block self-replication when this turn is itself a loop fire.
      "nomos-loops": buildLoopMcpServer(vaultUserId, {
        hasCronEngine: true,
        isLoopContext: source?.platform === "cron" || (sessionKey?.startsWith("cron:") ?? false),
      }),
    };
    // Studio (hosted-only feature), scoped to this owner. Gated so power-user
    // installs never load the extra tooling.
    if (FEATURES.studio()) {
      const studioServers: Record<string, ReturnType<typeof buildStudioMcpServer>> = {
        "nomos-studio": buildStudioMcpServer(vaultUserId),
      };
      mcpServers = { ...mcpServers, ...studioServers };
    }
    // Google Classroom (opt-in student-assistant capability) — HOSTED only: no Bash
    // in hosted, so the agent reaches Classroom through this REST MCP. Power-user uses
    // the gws CLI via the gws-classroom skill. Registers only for accounts that granted
    // classroom scopes (per-account consent), so non-students stay dark.
    if (FEATURES.classroom() && isHosted() && userId) {
      try {
        // Classroom is INTENT-driven: only accounts connected through the Classroom flow
        // (classroomConnected) get the tools. A Workspace reconnect that cumulatively
        // carries classroom scopes does NOT enable it — there's no reliable domain signal
        // (K-12 schools use custom domains; .edu is universities, which use Canvas).
        const accts = (await listGoogleAccounts(userId)).filter((a) => a.classroomConnected);
        if (accts.length > 0) {
          // Write tools require BOTH the deployment off-switch (NOMOS_CLASSROOM_WRITE)
          // AND a connected account that actually granted the read-write scope. Either
          // off → read-only (no draft-submit/reclaim). Turn-in stays consent-gated too.
          const writeEnabled =
            FEATURES.classroomWrite() && accts.some((a) => hasClassroomWriteScope(a.scopes));
          // Bind tools to the classroom account (the school account that granted the
          // scopes), preferring one that has write — so Classroom uses the right
          // account even when the user's DEFAULT Google account is a different one.
          const classroomAccount =
            accts.find((a) => hasClassroomWriteScope(a.scopes))?.email ?? accts[0].email;
          const classroomServers: Record<string, ReturnType<typeof buildClassroomMcpServer>> = {
            "nomos-google-classroom": buildClassroomMcpServer({
              userId,
              writeEnabled,
              defaultAccount: classroomAccount,
              createDraft: (a) => this.createClassroomDraft(a),
            }),
          };
          mcpServers = { ...mcpServers, ...classroomServers };
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "failed to register Google Classroom MCP",
        );
      }
    }
    // Native device tools (Calendar + Reminders) — HOSTED only, and ONLY while the
    // user's phone holds the DeviceBridge stream open (else the tools would always
    // fail). The tools route to that phone's EventKit via the bridge; the device
    // enforces its own permission prompts, so consent stays on-device.
    if (FEATURES.nativeDevice() && isHosted() && userId && getDeviceBridge().isConnected(userId)) {
      const deviceServers: Record<string, ReturnType<typeof buildNativeDeviceMcpServer>> = {
        "nomos-native-device": buildNativeDeviceMcpServer(userId),
      };
      mcpServers = { ...mcpServers, ...deviceServers };
    }
    let googlePrompt = "";
    if (isHosted() && userId) {
      try {
        const googleServers = await buildGoogleMcpServers(userId);
        const hasGoogle = Object.keys(googleServers).length > 0;
        if (hasGoogle) {
          mcpServers = { ...mcpServers, ...googleServers };
        }
        // State the truth either way: when connected, that it HAS access (so it
        // stops claiming Google needs configuring); when NOT, that Google is
        // disconnected (so it stops hunting for tools / browser-driving / faking a
        // workaround and instead tells the user to reconnect in Settings).
        googlePrompt = await buildGoogleIntegrationPrompt(userId, hasGoogle);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "failed to build Google MCP servers",
        );
      }
    }

    // Team delegation is native (Phase G): when team mode is on, `Agent` is added to
    // allowedTools below and the system prompt nudges the model to spawn parallel
    // subagents via the Agent tool. No in-loop delegate_to_team MCP tool is needed.

    // Reasoning-first: always-inject what the agent already knows about the user,
    // so it stays continuous without having to call a recall tool first.
    const memoryDigest = await buildMemoryDigest(vaultUserId).catch(() => "");

    // Elapsed-time anchor: how long since the last conversation, so the agent has a
    // temporal sense between sessions (not just "now") — it can pick up naturally.
    let elapsedAnchor = "";
    if (sessionKey) {
      try {
        const { getPreviousSessionEnd } = await import("../db/sessions.ts");
        const last = await getPreviousSessionEnd(vaultUserId, sessionKey);
        const ago = last ? formatElapsedSince(last) : "";
        if (ago) {
          elapsedAnchor = `## Continuity\nYour last conversation with the user ended **${ago} ago**. Your memory carries over, but time has passed — don't assume nothing has changed since then.`;
        }
      } catch {
        /* sessions unavailable; skip */
      }
    }

    // Open mood episodes: the cause(s) the user was recently stretched about, so the
    // agent can gently follow up on the THING — never assert a mood. Decayed; the live
    // read always wins.
    let moodContext = "";
    try {
      const { readOpenMoodEpisodes } = await import("../memory/mood-log.ts");
      const open = await readOpenMoodEpisodes(vaultUserId);
      if (open.length > 0) {
        const lines = open
          .slice(0, 5)
          .map((e) => `- ${e.cause} (seemed ${e.emotion}, ${e.date})`)
          .join("\n");
        moodContext = `## Recently weighing on them\nThings the user was stretched about lately. You MAY gently follow up on the cause ("how'd the launch land?") — never assert their current mood. The live read above wins: if they seem fine now, they're fine.\n${lines}`;
      }
    } catch {
      /* mood log unavailable; skip */
    }

    // Query-specific: surface the most relevant compiled wiki articles for this
    // turn (FTS over the owner's wiki, 4000-char budget). Empty when the wiki is
    // empty or the prompt has no matches. Scoped to the resolved owner.
    const wikiContext = await getRelevantArticles(vaultUserId, prompt).catch(() => "");

    // Auto-approve all tools from our MCP servers
    const allowedTools = Object.keys(mcpServers).map((name) => `mcp__${name}`);
    // G — native subagents: with team mode on (or NOMOS_NATIVE_AGENTS), the model
    // delegates via the Agent tool. Subagents inherit the parent hooks
    // (block_critical), so safety is structural. This is the ONLY team mechanism
    // now — the hand-rolled TeamRuntime was deleted.
    const useNativeAgents = nativeAgentsEnabled() || useNativeTeam(this.config.teamMode);
    if (useNativeAgents) allowedTools.push("Agent");

    let systemPromptAppend = this.systemPromptAppend;
    // Native team delegation (Phase G): when team mode is on, nudge the model to
    // spawn parallel subagents via the SDK `Agent` tool — they run with isolated
    // context and inherit this turn's permissions. No `/team` prefix needed.
    if (useNativeTeam(this.config.teamMode)) {
      systemPromptAppend =
        systemPromptAppend +
        "\n\n## Working as a team\nWhen a request is genuinely parallelizable — research from several angles at once, audit multiple things, draft separate sections, compare options — delegate with the `Agent` tool: spawn a `team-worker` subagent per independent piece (they run in parallel, each with its own fresh context), then synthesize their results into one reply. Use the read-only `verifier` subagent to adversarially check important results before you trust them. Reserve delegation for multi-angle or heavy work; do the simple single-step tasks yourself. (Power users can also start a message with `/team`.)";
    }

    // Inject transient Theory of Mind state (per-message, not persisted)
    if (userState) {
      systemPromptAppend = systemPromptAppend + "\n\n" + userState;
    }

    // Inject active persona overrides (per-message, context-dependent)
    if (personaPrompt) {
      systemPromptAppend = systemPromptAppend + "\n\n" + personaPrompt;
    }

    // Inject the requesting user's connected Google accounts (hosted, per-user)
    if (googlePrompt) {
      systemPromptAppend = systemPromptAppend + "\n\n" + googlePrompt;
    }

    // Inject the reasoning-first memory digest (what the agent knows about the user)
    if (memoryDigest) {
      systemPromptAppend = systemPromptAppend + "\n\n" + memoryDigest;
    }

    // Inject the elapsed-time anchor (how long since the last conversation)
    if (elapsedAnchor) {
      systemPromptAppend = systemPromptAppend + "\n\n" + elapsedAnchor;
    }

    // Inject open mood episodes (gentle follow-up on the cause, never assert a mood)
    if (moodContext) {
      systemPromptAppend = systemPromptAppend + "\n\n" + moodContext;
    }

    // Inject query-relevant wiki articles LAST so the stable prefix (system
    // prompt, tools, digest) stays prompt-cacheable up to this point.
    if (wikiContext) {
      systemPromptAppend = systemPromptAppend + "\n\n" + wikiContext;
    }

    // Writing-voice guidance (opt-in styleMatching): make the agent write in the
    // owner's style, derived from their sent messages by the daily analysis job.
    if (this.config.styleMatching) {
      try {
        const { buildStyleGuidance } = await import("../memory/style-prompt.ts");
        const styleGuidance = await buildStyleGuidance(vaultUserId);
        if (styleGuidance) systemPromptAppend = systemPromptAppend + "\n\n" + styleGuidance;
      } catch (err) {
        log.debug({ err }, "Style guidance injection failed");
      }
    }

    // Mobile / local-terminal clients have no channel adapter, so render the Ask card
    // over THIS open chat stream via `emit` (the answer returns out-of-band via
    // AnswerQuestion). Slack/other channels render via their adapter (Block Kit buttons).
    const elicitationOnStream = Boolean(
      mgr && source && (source.platform === "mobile" || source.platform === "terminal"),
    );
    if (elicitationOnStream && mgr && source) mgr.registerEmitter(source, emit);

    // The agent asks via the native `AskUserQuestion` tool; this canUseTool handler
    // routes its questions through the ElicitationManager → the Ask card (Phase F).
    const canUseTool = mgr && source ? buildAskCanUseTool(mgr, source) : undefined;

    const runParams: RunSessionParams = {
      prompt,
      model: model ?? this.config.model,
      systemPromptAppend,
      mcpServers,
      // Daemon runs unattended — no human to approve tool calls.
      // Use bypassPermissions so tools like filesystem search and web search work.
      permissionMode: "bypassPermissions",
      allowedTools,
      disallowedTools: getDisallowedTools(),
      resume: resumeId,
      maxTurns: 50,
      // B.1 — optional USD ceiling on the unattended main turn (NOMOS_TURN_BUDGET_USD).
      // Unset = no cap (preserves today's behavior). The SDK ends the turn with a
      // result whose subtype is `error_max_budget_usd` (surfaced gracefully below).
      maxBudgetUsd: this.config.turnBudgetUsd,
      sandbox: buildSandboxConfig(),
      ...(useNativeAgents ? { agents: buildNativeAgents() } : {}),
      ...(canUseTool
        ? { canUseTool, toolConfig: { askUserQuestion: { previewFormat: "markdown" } } }
        : {}),
      anthropicBaseUrl: this.config.anthropicBaseUrl,
      plugins: this.plugins,
      useSubscription: this.config.useSubscription,
      // PreToolUse blocking from ~/.nomos/hooks.json (no-op when none registered)
      // PLUS the TOOL_APPROVAL_POLICY gate (block_critical by default). Honored
      // even in bypassPermissions mode -- the safety net for unattended runs.
      hooks: buildSdkHooks({
        sessionKey: sessionKey ?? "daemon",
        approvalPolicy: this.config.toolApprovalPolicy,
      }),
      stderr: (data: string) => {
        // Log SDK subprocess stderr so we can diagnose crash reasons
        const trimmed = data.trim();
        if (trimmed) log.error(`[stderr] ${trimmed}`);
      },
    };

    // Layer A: when held-open streaming sessions are enabled and this is a real
    // per-session turn, run it through the live session (in-context, zero-warmup);
    // a background-task resume rides the same live session. Otherwise the default
    // one-shot drain below runs unchanged.
    if (this.liveSessions && sessionKey && typeof prompt === "string") {
      const st = await this.liveSessions.runTurn(sessionKey, runParams, emit);
      if (elicitationOnStream && mgr && source) mgr.unregisterEmitter(source);
      return {
        text: st.text.toString(),
        sessionId: st.sessionId,
        costUsd: st.costUsd,
        inputTokens: st.inputTokens,
        outputTokens: st.outputTokens,
      };
    }

    // D.2 — a per-session AbortController so an in-flight one-shot turn can be
    // cancelled (kills the SDK subprocess, stops billing). Keyed by sessionKey and
    // overwritten each turn, so no unbounded growth; cleared on normal completion.
    const turnAbort = new AbortController();
    if (sessionKey) this.turnAborts.set(sessionKey, turnAbort);
    const sdkQuery = runSession({ ...runParams, abortController: turnAbort });

    const acc = new AssistantText();
    let sessionId: string | undefined;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const msg of sdkQuery) {
      // Forward all SDK events to the emitter
      switch (msg.type) {
        case "assistant": {
          // A.2 — a refusal-fallback replacement carries `supersedes`; evict the
          // refused partial on arrival (idempotent with the end-of-turn notice).
          acc.evict((msg as { supersedes?: string[] }).supersedes);
          const uuid = (msg as { uuid?: string }).uuid ?? "";
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              acc.add(uuid, block.text);
            } else if (block.type === "tool_use" || block.type === "server_tool_use") {
              // The model called a tool. Surface it as a tool_use_summary event so
              // clients (CLI, mobile) can render a tool-use card. The SDK never sends
              // a standalone "tool_use_summary" message -- tool calls only arrive as
              // content blocks on the assistant turn, so this is the one place to
              // catch them (incl. server tools like web_search).
              const toolName = (block as { name?: string }).name ?? "unknown";
              const summary = summarizeToolInput(toolName, (block as { input?: unknown }).input);
              // Plumbing / dedicated-card tools don't render a generic tool card (see
              // SILENT_TOOLS): AskUserQuestion has the Ask card; ToolSearch, the MCP
              // resource tools, and Skill are internal setup, not user-meaningful work.
              if (!isSilentTool(toolName)) {
                emit({ type: "tool_use_summary", tool_name: toolName, summary });
              }
              // TodoWrite also drives a richer Plan card (clients suppress its tool card).
              if (toolName === "TodoWrite") {
                const plan = todoWriteToPlan((block as { input?: unknown }).input);
                if (plan) emit(plan);
              }
              // Shadow mode: record tool usage observation.
              if (this.shadowObserver?.isEnabled() && sessionKey) {
                this.shadowObserver.recordToolUse(toolName, summary, sessionKey);
                if (["Read", "Edit", "Write"].includes(toolName) && summary) {
                  const action = toolName.toLowerCase() as "read" | "edit" | "write";
                  this.shadowObserver.recordFileAccess(summary, action);
                }
              }
            }
          }
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "stream_event": {
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "result": {
          sessionId = msg.session_id;
          costUsd = msg.total_cost_usd ?? 0;
          inputTokens = msg.usage?.input_tokens ?? 0;
          outputTokens = msg.usage?.output_tokens ?? 0;
          accrueModelUsage(msg);
          // Don't append msg.result -- it's the same final text we already
          // accumulated from the `assistant` block.text events, so adding it
          // again would double the response. Use it only as a fallback when
          // we somehow missed every assistant event (rare; e.g. compaction).
          if ("result" in msg && acc.isEmpty && typeof msg.result === "string") {
            acc.setResult(msg.result);
          }
          // B.1 — graceful "hit the cap" message instead of an empty/opaque error.
          if ((msg as { subtype?: string }).subtype === "error_max_budget_usd" && acc.isEmpty) {
            acc.setResult(BUDGET_CAP_NOTICE);
          }
          emit({
            type: "result",
            result: "result" in msg ? msg.result : "",
            usage: msg.usage,
            total_cost_usd: msg.total_cost_usd,
            session_id: msg.session_id,
          });
          break;
        }

        case "system": {
          const sysMsg = msg as {
            session_id?: string;
            subtype: string;
            tools?: unknown[];
            mcp_servers?: unknown[];
            status?: string;
            compact_metadata?: { trigger: string; pre_tokens: number };
          };
          if (sysMsg.session_id && !sessionId) {
            sessionId = sysMsg.session_id;
          }
          // A.2 — end-of-turn refusal-fallback notice: evict the refused partial
          // (idempotent backstop to the per-message `supersedes` above).
          if (sysMsg.subtype === "model_refusal_fallback") {
            acc.evict((msg as { retracted_message_uuids?: string[] }).retracted_message_uuids);
          }
          emit({
            type: "system",
            subtype: sysMsg.subtype,
            message: formatSystemMessage(sysMsg),
            data: sysMsg as unknown as Record<string, unknown>,
          });
          break;
        }

        default:
          break;
      }
    }

    if (sessionKey) this.turnAborts.delete(sessionKey);
    if (elicitationOnStream && mgr && source) mgr.unregisterEmitter(source);

    return { text: acc.toString(), sessionId, costUsd, inputTokens, outputTokens };
  }

  /**
   * D.2 — interrupt the in-flight turn for a session. The held-open live session
   * is interrupted gracefully via `Query.interrupt()` (the session survives); a
   * one-shot turn is cancelled by aborting its controller. Returns true if a turn
   * was actually in flight. Wired to the gRPC `interrupt:<sessionKey>` command.
   */
  interruptSession(sessionKey: string): boolean {
    let interrupted = this.liveSessions?.interrupt(sessionKey) ?? false;
    const ac = this.turnAborts.get(sessionKey);
    if (ac) {
      ac.abort();
      this.turnAborts.delete(sessionKey);
      interrupted = true;
    }
    if (interrupted) log.info({ sessionKey }, "turn interrupted");
    return interrupted;
  }

  /**
   * Convert one SDK message into client events + accumulated turn state; returns
   * true on turn-over (`result`). Used by the held-open live-session manager so it
   * shares the same drain semantics as the one-shot path above.
   */
  private handleSdkMessage(
    msg: SDKMessage,
    emit: (event: AgentEvent) => void,
    state: LiveTurnState,
    sessionKey: string,
  ): boolean {
    switch (msg.type) {
      case "assistant": {
        state.text.evict((msg as { supersedes?: string[] }).supersedes);
        const uuid = (msg as { uuid?: string }).uuid ?? "";
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            state.text.add(uuid, block.text);
          } else if (block.type === "tool_use" || block.type === "server_tool_use") {
            const toolName = (block as { name?: string }).name ?? "unknown";
            const summary = summarizeToolInput(toolName, (block as { input?: unknown }).input);
            if (!isSilentTool(toolName)) {
              emit({ type: "tool_use_summary", tool_name: toolName, summary });
            }
            if (toolName === "TodoWrite") {
              const plan = todoWriteToPlan((block as { input?: unknown }).input);
              if (plan) emit(plan);
            }
            if (this.shadowObserver?.isEnabled()) {
              this.shadowObserver.recordToolUse(toolName, summary, sessionKey);
              if (["Read", "Edit", "Write"].includes(toolName) && summary) {
                const action = toolName.toLowerCase() as "read" | "edit" | "write";
                this.shadowObserver.recordFileAccess(summary, action);
              }
            }
          }
        }
        emit({ type: "stream_event", event: msg });
        return false;
      }
      case "stream_event": {
        emit({ type: "stream_event", event: msg });
        return false;
      }
      case "result": {
        state.sessionId = msg.session_id;
        state.costUsd = msg.total_cost_usd ?? 0;
        state.inputTokens = msg.usage?.input_tokens ?? 0;
        state.outputTokens = msg.usage?.output_tokens ?? 0;
        accrueModelUsage(msg);
        if ("result" in msg && state.text.isEmpty && typeof msg.result === "string") {
          state.text.setResult(msg.result);
        }
        if (
          (msg as { subtype?: string }).subtype === "error_max_budget_usd" &&
          state.text.isEmpty
        ) {
          state.text.setResult(BUDGET_CAP_NOTICE);
        }
        emit({
          type: "result",
          result: "result" in msg ? msg.result : "",
          usage: msg.usage,
          total_cost_usd: msg.total_cost_usd,
          session_id: msg.session_id,
        });
        return true;
      }
      case "system": {
        const sysMsg = msg as {
          session_id?: string;
          subtype: string;
          tools?: unknown[];
          mcp_servers?: unknown[];
          status?: string;
          compact_metadata?: { trigger: string; pre_tokens: number };
        };
        if (sysMsg.session_id && !state.sessionId) state.sessionId = sysMsg.session_id;
        if (sysMsg.subtype === "model_refusal_fallback") {
          state.text.evict((msg as { retracted_message_uuids?: string[] }).retracted_message_uuids);
        }
        emit({
          type: "system",
          subtype: sysMsg.subtype,
          message: formatSystemMessage(sysMsg),
          data: sysMsg as unknown as Record<string, unknown>,
        });
        return false;
      }
      default:
        return false;
    }
  }
}

export function formatSystemMessage(msg: {
  subtype: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  status?: string;
  description?: string;
  summary?: string;
  task_id?: string;
  compact_metadata?: { trigger: string; pre_tokens: number };
}): string {
  if (msg.subtype === "init") {
    const toolCount = (msg.tools as unknown[])?.length ?? 0;
    const mcpCount = (msg.mcp_servers as unknown[])?.length ?? 0;
    return `${toolCount} tools, ${mcpCount} MCP servers`;
  }
  if (msg.subtype === "status" && msg.status === "compacting") {
    return "Compacting conversation...";
  }
  if (msg.subtype === "compact_boundary" && msg.compact_metadata) {
    const preTokens = msg.compact_metadata.pre_tokens;
    const formatted = preTokens >= 1000 ? `${(preTokens / 1000).toFixed(1)}K` : String(preTokens);
    return `Context compacted (was ~${formatted} tokens)`;
  }
  // Native background-task lifecycle (surfaced by streaming sessions) — render a
  // real "pending CI / finished" status instead of the raw subtype, so the UI can
  // show a live background-work chip and a meaningful completion.
  if (msg.subtype === "task_started") {
    return `Background task started: ${msg.description ?? msg.task_id ?? "task"}`;
  }
  if (msg.subtype === "task_notification") {
    return `Background task ${msg.status ?? "settled"}: ${msg.summary ?? msg.task_id ?? "task"}`;
  }
  if (msg.subtype === "task_progress" || msg.subtype === "task_updated") {
    return `Background task ${msg.status ?? "running"}`;
  }
  return msg.subtype;
}
