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
import { loadEnvConfig, type NomosConfig } from "../config/env.ts";
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

  private initialized = false;

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

      console.log(
        `[agent-runtime] Reloaded ${Object.keys(wsServers).length} workspace MCP server(s)`,
      );
    } catch (err) {
      console.error("[agent-runtime] Failed to reload workspace MCPs:", err);
    }
  }

  /** Initialize the runtime: run migrations, load all config. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Run DB migrations
    await runMigrations();

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
      console.log(
        `[agent-runtime] Pre-installed ${newlyInstalled.length} default plugin(s): ${newlyInstalled.join(", ")}`,
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
      // gws CLI is used via Bash (not MCP) -- no MCP server to register.
      // Sync authorized accounts from gws CLI to DB and load for system prompt
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

    // Load user model for adaptive behavior
    let userModel: import("../db/user-model.ts").UserModelEntry[] | undefined;
    let exemplars: import("../config/profile.ts").ExemplarEntry[] | undefined;
    if (this.config.adaptiveMemory) {
      try {
        const { getUserModel } = await import("../db/user-model.ts");
        userModel = await getUserModel();
      } catch {
        // Table may not exist yet -- skip
      }

      // Load exemplars for few-shot personality priming
      try {
        const { retrieveExemplars } = await import("../memory/exemplars.ts");
        const stored = await retrieveExemplars("general conversation", undefined, 3);
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
        await this.shadowObserver.loadFromDisk();
      } catch {
        // No prior observations -- start fresh
      }
    }

    this.initialized = true;
    console.log("[agent-runtime] Initialized");
    console.log(`[agent-runtime]   Model: ${this.config.model}`);
    if (this.config.teamMode) {
      console.log(
        `[agent-runtime]   Team mode: enabled (max ${this.config.maxTeamWorkers} workers)`,
      );
    }
    if (this.config.adaptiveMemory) {
      console.log(
        `[agent-runtime]   Adaptive memory: enabled${userModel?.length ? ` (${userModel.length} model entries)` : ""}`,
      );
    }
    if (this.config.shadowMode) {
      const stats = this.shadowObserver!.getStats();
      console.log(
        `[agent-runtime]   Shadow mode: enabled (${stats.tools} tool obs, ${stats.corrections} corrections)`,
      );
    }
    if (this.config.anthropicBaseUrl) {
      console.log(`[agent-runtime]   API base URL: ${this.config.anthropicBaseUrl}`);
    }
    console.log(`[agent-runtime]   Identity: ${this.identity.emoji ?? ""} ${this.identity.name}`);
    console.log(`[agent-runtime]   MCP servers: ${Object.keys(this.mcpServers).join(", ")}`);
    if (this.plugins.length > 0) {
      const pluginNames = this.plugins.map((p) => p.path.split("/").pop()).join(", ");
      console.log(`[agent-runtime]   Plugins: ${pluginNames}`);
    }
    if (this.personas.length > 0) {
      const personaNames = this.personas.filter((p) => p.enabled).map((p) => p.name);
      console.log(`[agent-runtime]   Personas: ${personaNames.join(", ")}`);
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
    if (this.gwsAccounts && this.gwsAccounts.length > 0) {
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

    // Ensure DB session exists
    await createDbSession({
      sessionKey,
      model: this.config.model,
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
      console.log(
        `[agent-runtime] Smart routing: "${classification.tier}" (confidence: ${classification.confidence.toFixed(2)}) → ${model}`,
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
    console.log(
      `[agent-runtime] Team check: teamRuntime=${!!this.teamRuntime}, teamTask=${!!teamTask}`,
    );
    if (teamTask && this.teamRuntime) {
      console.log(`[agent-runtime] Executing team task: ${teamTask.slice(0, 100)}`);

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
        console.log(`[agent-runtime] Team result: ${content.length} chars`);

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
      console.error(
        `[agent-runtime] SDK error (model: ${model ?? this.config.model}, resume: ${!!resumeId}): ${errMsg}`,
      );

      // If resume failed, retry without resume.
      // "exited with code 1" is a generic SDK crash that often indicates a corrupt/stale session.
      if (resumeId && /session|conversation|exited with code/i.test(errMsg)) {
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
  ): Promise<{
    text: string;
    sessionId?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  }> {
    // Auto-approve all tools from our MCP servers
    const allowedTools = Object.keys(this.mcpServers).map((name) => `mcp__${name}`);

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

    const sdkQuery = runSession({
      prompt,
      model: model ?? this.config.model,
      systemPromptAppend,
      mcpServers: this.mcpServers,
      // Daemon runs unattended — no human to approve tool calls.
      // Use bypassPermissions so tools like filesystem search and web search work.
      permissionMode: "bypassPermissions",
      allowedTools,
      resume: resumeId,
      maxTurns: 50,
      anthropicBaseUrl: this.config.anthropicBaseUrl,
      plugins: this.plugins,
      useSubscription: this.config.useSubscription,
      stderr: (data: string) => {
        // Log SDK subprocess stderr so we can diagnose crash reasons
        const trimmed = data.trim();
        if (trimmed) console.error(`[agent-runtime:stderr] ${trimmed}`);
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
          if ("result" in msg) {
            fullText += msg.result;
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
