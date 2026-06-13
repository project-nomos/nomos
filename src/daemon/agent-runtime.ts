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
  type SDKMessage,
  type SdkPluginConfig,
} from "../sdk/session.ts";
import { buildSdkHooks } from "../hooks/sdk-adapter.ts";
import { loadInstalledPlugins, toSdkPluginConfigs } from "../plugins/loader.ts";
import { ensureDefaultPlugins } from "../plugins/installer.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { TeamRuntime, stripTeamPrefix } from "./team-runtime.ts";
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
import { buildStudioMcpServer } from "../sdk/studio-mcp.ts";
import { buildVaultMcpServer } from "../sdk/vault-mcp.ts";
import { buildThinkMcpServer } from "../sdk/think-mcp.ts";
import { buildLoopMcpServer } from "../sdk/loop-mcp.ts";
import { buildMemoryDigest } from "../memory/digest.ts";
import { getRelevantArticles } from "../memory/wiki-reader.ts";
import { loadEnvConfig, type NomosConfig } from "../config/env.ts";
import { FEATURES, isHosted } from "../config/mode.ts";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";

/**
 * Built-in tools blocked when hosted-mode feature gates demand it. Centralized
 * here so both single-agent and team-runtime call sites stay consistent.
 */
function getDisallowedTools(): string[] {
  const blocked: string[] = [];
  if (!FEATURES.bashTool()) {
    blocked.push("Bash", "BashOutput", "KillBash");
  }
  return blocked;
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

export class AgentRuntime {
  // Cached at startup
  private plugins: SdkPluginConfig[] = [];
  private config!: NomosConfig;
  private profile!: UserProfile;
  private identity!: AgentIdentity;
  private systemPromptAppend!: string;
  private mcpServers!: Record<string, McpServerConfig>;

  // SDK session ID cache: sessionKey → SDK session ID
  private sdkSessionIds = new Map<string, string>();

  // Per-session team context: carries the team result into subsequent turns
  // so the regular agent has context of what the team did.
  private teamContext = new Map<string, string>();

  // Multi-agent team runtime (when teamMode is enabled)
  private teamRuntime?: TeamRuntime;

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

  private initialized = false;

  /** Wire in the elicitation manager. Called by the gateway after construction. */
  setElicitationManager(mgr: import("./elicitation-manager.ts").ElicitationManager): void {
    this.elicitationManager = mgr;
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

    // Initialize team runtime if team mode is enabled
    if (this.config.teamMode) {
      this.teamRuntime = new TeamRuntime({
        maxWorkers: this.config.maxTeamWorkers,
        workerBudgetUsd: this.config.workerBudgetUsd,
        coordinatorModel: this.config.model,
      });
    }

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

    if (this.slackWorkspaces && this.slackWorkspaces.length > 0) {
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
    if (isDiscordConfigured()) {
      parts.push("- **Discord**: Send and receive messages via Discord bot");
    }
    if (isTelegramConfigured()) {
      parts.push("- **Telegram**: Send and receive messages via Telegram bot");
    }
    if (!isHosted() && this.gwsAccounts && this.gwsAccounts.length > 0) {
      const accountList = this.gwsAccounts
        .map((a) => `  - ${a.email}${a.isDefault ? " (default)" : ""}`)
        .join("\n");
      parts.push(
        [
          `- **Google Workspace** (via \`gws\` CLI -- use Bash tool to run commands):`,
          `  Authorized accounts:\n${accountList}`,
          `  **Usage**: Run \`npx @googleworkspace/cli <service> <resource> <method> --params '<JSON>'\` via the Bash tool.`,
          `  **Examples**:`,
          `    - List emails: \`npx @googleworkspace/cli gmail users messages list --params '{"userId":"me","maxResults":5}'\``,
          `    - Read email: \`npx @googleworkspace/cli gmail users messages get --params '{"userId":"me","id":"<msgId>","format":"full"}'\``,
          `    - Send email: \`npx @googleworkspace/cli gmail users messages send --params '{"userId":"me"}' --json '{"raw":"<base64>"}'\``,
          `    - List events: \`npx @googleworkspace/cli calendar events list --params '{"calendarId":"primary","maxResults":5}'\``,
          `    - List files: \`npx @googleworkspace/cli drive files list --params '{"pageSize":10}'\``,
          `    - Search: \`npx @googleworkspace/cli gmail users messages list --params '{"userId":"me","q":"from:someone subject:topic"}'\``,
          `  **Multi-account**: The active account is the default. To switch, re-auth is needed.`,
          `  **Tip**: Use \`npx @googleworkspace/cli schema <service.resource.method>\` to check available params.`,
        ].join("\n"),
      );
    }

    // Check for WhatsApp
    if (process.env.WHATSAPP_ENABLED === "true") {
      parts.push("- **WhatsApp**: Receive and respond to messages via WhatsApp");
    }
    // Check for Messages.app (macOS only)
    if (this.isImessageEnabled()) {
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

    // Check for team mode trigger (/team prefix)
    const teamTask = this.teamRuntime ? stripTeamPrefix(message.content) : null;
    log.info(`Team check: teamRuntime=${!!this.teamRuntime}, teamTask=${!!teamTask}`);
    if (teamTask && this.teamRuntime) {
      log.info(`Executing team task: ${teamTask.slice(0, 100)}`);

      emit({
        type: "system",
        subtype: "status",
        message: "Running multi-agent team...",
      });

      try {
        const result = await this.teamRuntime.runTeam(
          {
            prompt: teamTask,
            systemPromptAppend: this.systemPromptAppend,
            mcpServers: this.mcpServers,
            permissionMode: "bypassPermissions",
            allowedTools: Object.keys(this.mcpServers).map((name) => `mcp__${name}`),
            disallowedTools: getDisallowedTools(),
            // Use smart-routed model (or default) — not the base config which may be haiku
            model,
            plugins: this.plugins,
          },
          (event) => {
            emit({
              type: "system",
              subtype: "status",
              message: event.message,
            });
          },
        );

        const content = result || "_(no response)_";
        log.info(`Team result: ${content.length} chars`);

        // Store team result so subsequent turns have context
        const teamSummary =
          content.length > 4000 ? content.slice(0, 4000) + "\n...(truncated)" : content;
        this.teamContext.set(
          sessionKey,
          `## Previous Team Result\nThe user asked: ${teamTask.slice(0, 500)}\n\nThe multi-agent team produced this result:\n${teamSummary}`,
        );

        // Emit the team result as stream events so gRPC/WebSocket clients render it
        emit({
          type: "stream_event",
          event: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: content },
            },
          } as unknown as SDKMessage,
        });
        emit({
          type: "result",
          result: content,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        });

        return {
          inReplyTo: message.id,
          platform: message.platform,
          channelId: message.channelId,
          threadId: message.threadId,
          content,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message: errMsg });

        // Return error as content instead of re-throwing (prevents duplicate error events)
        emit({
          type: "result",
          result: `Team error: ${errMsg}`,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        });

        return {
          inReplyTo: message.id,
          platform: message.platform,
          channelId: message.channelId,
          threadId: message.threadId,
          content: `Team error: ${errMsg}`,
        };
      }
    }

    // Shadow mode: record turn for response cadence tracking
    this.shadowObserver?.recordTurn();

    // Update Theory of Mind tracker for this session
    let tomTracker = this.tomTrackers.get(sessionKey);
    if (!tomTracker) {
      tomTracker = new TheoryOfMindTracker();
      this.tomTrackers.set(sessionKey, tomTracker);
    }
    tomTracker.update(message.content);
    const userState = tomTracker.formatForPrompt();

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

      // Cache the new SDK session ID
      if (result.sessionId) {
        this.sdkSessionIds.set(sessionKey, result.sessionId);
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
    let mcpServers = {
      ...this.mcpServers,
      "nomos-vault": buildVaultMcpServer(vaultUserId),
      // Rebuild the memory tools per-turn so memory_search is scoped to this
      // owner (the cached one at init has no user). Overrides the cached entry.
      "nomos-memory": createMemoryMcpServer(vaultUserId),
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
    let googlePrompt = "";
    if (isHosted() && userId) {
      try {
        const googleServers = await buildGoogleMcpServers(userId);
        if (Object.keys(googleServers).length > 0) {
          mcpServers = { ...mcpServers, ...googleServers };
        }
        // Tell the agent it actually HAS this access, otherwise it trusts the
        // static integrations summary (which lists only power-user channels) and
        // wrongly claims Gmail/Calendar/Drive aren't configured.
        googlePrompt = await buildGoogleIntegrationPrompt(userId);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "failed to build Google MCP servers",
        );
      }
    }

    // Reasoning-first: always-inject what the agent already knows about the user,
    // so it stays continuous without having to call a recall tool first.
    const memoryDigest = await buildMemoryDigest(vaultUserId).catch(() => "");

    // Query-specific: surface the most relevant compiled wiki articles for this
    // turn (FTS over the owner's wiki, 4000-char budget). Empty when the wiki is
    // empty or the prompt has no matches. Scoped to the resolved owner.
    const wikiContext = await getRelevantArticles(vaultUserId, prompt).catch(() => "");

    // Auto-approve all tools from our MCP servers
    const allowedTools = Object.keys(mcpServers).map((name) => `mcp__${name}`);

    // Inject team context from a previous /team turn (if any)
    let systemPromptAppend = this.systemPromptAppend;
    if (sessionKey) {
      const teamCtx = this.teamContext.get(sessionKey);
      if (teamCtx) {
        systemPromptAppend = systemPromptAppend + "\n\n" + teamCtx;
        // Clear after one use -- it's now part of the conversation via the SDK session
        this.teamContext.delete(sessionKey);
      }
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

    // Build the elicitation callback for this turn. The `ask_user` MCP
    // tool calls `extra.sendRequest({method: "elicitation/create"})`;
    // the SDK forwards to `onElicitation`, we route to the channel the
    // user is currently talking to us on, and return their answer.
    const mgr = this.elicitationManager;
    const onElicitation: import("../sdk/session.ts").RunSessionParams["onElicitation"] =
      mgr && source
        ? (request, opts) => mgr.handleElicitation(request, source, opts.signal)
        : undefined;

    const sdkQuery = runSession({
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
      anthropicBaseUrl: this.config.anthropicBaseUrl,
      plugins: this.plugins,
      useSubscription: this.config.useSubscription,
      onElicitation,
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
    });

    let fullText = "";
    let sessionId: string | undefined;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const msg of sdkQuery) {
      // Forward all SDK events to the emitter
      switch (msg.type) {
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              if (fullText && !fullText.endsWith("\n")) fullText += "\n";
              fullText += block.text;
            }
          }
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "stream_event": {
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "tool_use_summary": {
          const toolName = (msg as { tool_name?: string }).tool_name ?? "unknown";
          emit({
            type: "tool_use_summary",
            tool_name: toolName,
            summary: msg.summary,
          });
          // Shadow mode: record tool usage observation
          if (this.shadowObserver?.isEnabled() && sessionKey) {
            this.shadowObserver.recordToolUse(toolName, msg.summary, sessionKey);
            // Record file access for Read/Edit/Write tools
            if (["Read", "Edit", "Write"].includes(toolName) && typeof msg.summary === "string") {
              const pathMatch = msg.summary.match(/(?:Read|Edit|Write)\s+(\S+)/);
              if (pathMatch) {
                const action = toolName.toLowerCase() as "read" | "edit" | "write";
                this.shadowObserver.recordFileAccess(pathMatch[1]!, action);
              }
            }
          }
          break;
        }

        case "result": {
          sessionId = msg.session_id;
          costUsd = msg.total_cost_usd ?? 0;
          inputTokens = msg.usage?.input_tokens ?? 0;
          outputTokens = msg.usage?.output_tokens ?? 0;
          // Don't append msg.result -- it's the same final text we already
          // accumulated from the `assistant` block.text events, so adding it
          // again would double the response. Use it only as a fallback when
          // we somehow missed every assistant event (rare; e.g. compaction).
          if ("result" in msg && !fullText && typeof msg.result === "string") {
            fullText = msg.result;
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

    return { text: fullText, sessionId, costUsd, inputTokens, outputTokens };
  }
}

function formatSystemMessage(msg: {
  subtype: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  status?: string;
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
  return msg.subtype;
}
