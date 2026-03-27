/**
 * Centralized agent runtime for the daemon.
 *
 * Loads config, identity, profile, skills, and MCP once at startup (cached).
 * Processes messages through the Claude Agent SDK via `runSession()`.
 * Manages SDK session IDs backed by the DB sessions table.
 */

import { runSession, type McpServerConfig, type SDKMessage } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { TeamRuntime, stripTeamPrefix } from "./team-runtime.ts";
import { isSlackConfigured, createSlackMcpServer } from "../sdk/slack-mcp.ts";
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
import {
  isGoogleWorkspaceConfiguredAsync,
  createGoogleWorkspaceMcpConfigsAsync,
} from "../sdk/google-workspace-mcp.ts";
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

export class AgentRuntime {
  // Cached at startup
  private config!: NomosConfig;
  private profile!: UserProfile;
  private identity!: AgentIdentity;
  private systemPromptAppend!: string;
  private mcpServers!: Record<string, McpServerConfig>;

  // SDK session ID cache: sessionKey → SDK session ID
  private sdkSessionIds = new Map<string, string>();

  // Multi-agent team runtime (when teamMode is enabled)
  private teamRuntime?: TeamRuntime;

  // Google Workspace authorized accounts
  private gwsAccounts?: Array<{ email: string; isDefault: boolean }>;

  private initialized = false;

  /** Get the configured model name. */
  getModel(): string {
    return this.config?.model ?? "claude-sonnet-4-6";
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

    // Channel MCP servers (when tokens are configured)
    if (isSlackConfigured()) {
      this.mcpServers["nomos-slack"] = createSlackMcpServer();
    }

    // Per-workspace Slack MCP servers for autonomous multi-workspace management
    try {
      const { createPerWorkspaceSlackMcpServers } = await import("../sdk/slack-workspace-mcp.ts");
      const wsServers = await createPerWorkspaceSlackMcpServers();
      Object.assign(this.mcpServers, wsServers);
    } catch {
      // DB not available or no workspaces configured — skip
    }

    if (isDiscordConfigured()) {
      this.mcpServers["nomos-discord"] = createDiscordMcpServer();
    }
    if (isTelegramConfigured()) {
      this.mcpServers["nomos-telegram"] = createTelegramMcpServer();
    }
    if (await isGoogleWorkspaceConfiguredAsync()) {
      Object.assign(this.mcpServers, await createGoogleWorkspaceMcpConfigsAsync());
      // Load authorized accounts for system prompt
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
    if (this.config.adaptiveMemory) {
      try {
        const { getUserModel } = await import("../db/user-model.ts");
        userModel = await getUserModel();
      } catch {
        // Table may not exist yet — skip
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
    });

    // Initialize team runtime if team mode is enabled
    if (this.config.teamMode) {
      this.teamRuntime = new TeamRuntime({
        maxWorkers: this.config.maxTeamWorkers,
        coordinatorModel: this.config.model,
      });
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
    if (this.config.anthropicBaseUrl) {
      console.log(`[agent-runtime]   API base URL: ${this.config.anthropicBaseUrl}`);
    }
    console.log(`[agent-runtime]   Identity: ${this.identity.emoji ?? ""} ${this.identity.name}`);
    console.log(`[agent-runtime]   MCP servers: ${Object.keys(this.mcpServers).join(", ")}`);
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

    if (isSlackConfigured()) {
      parts.push("- **Slack** (Bot Mode): Send and receive messages via Slack bot");
    }
    const slackWsCount = Object.keys(this.mcpServers).filter((k) =>
      k.startsWith("slack-ws-"),
    ).length;
    if (slackWsCount > 0) {
      parts.push(
        `- **Slack** (User Mode): ${slackWsCount} workspace(s) connected — can send messages as the user`,
      );
    }
    if (isDiscordConfigured()) {
      parts.push("- **Discord**: Send and receive messages via Discord bot");
    }
    if (isTelegramConfigured()) {
      parts.push("- **Telegram**: Send and receive messages via Telegram bot");
    }
    if (this.mcpServers["google-workspace"]) {
      parts.push("- **Google Workspace**: All services via gws CLI MCP");
      // List authorized accounts so the agent knows about them
      if (this.gwsAccounts && this.gwsAccounts.length > 0) {
        const accountList = this.gwsAccounts
          .map((a) => `  - ${a.email}${a.isDefault ? " (default)" : ""}`)
          .join("\n");
        parts.push(`  Authorized accounts:\n${accountList}`);
        if (this.gwsAccounts.length > 1) {
          parts.push(
            "  Use `switch_google_account` to switch between accounts before making Google Workspace API calls.",
          );
        }
      }
    }

    // Check for WhatsApp
    if (process.env.WHATSAPP_ENABLED === "true") {
      parts.push("- **WhatsApp**: Receive and respond to messages via WhatsApp");
    }
    // Check for iMessage (macOS only)
    if (process.env.IMESSAGE_ENABLED === "true" && process.platform === "darwin") {
      parts.push("- **iMessage**: Receive and respond to messages via iMessage");
    }

    if (parts.length === 0) {
      return "No channel integrations are currently active. Only memory search is available.";
    }

    return [
      "The following integrations are loaded and available via MCP tools:",
      ...parts,
      "",
      "Use these integrations proactively when they can help fulfill the user's request.",
    ].join("\n");
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
      const shortModel = model.replace("claude-", "").replace(/-\d+$/, "");
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
          result: [{ type: "text", text: content }],
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
        throw err;
      }
    }

    emit({
      type: "system",
      subtype: "status",
      message: "Processing...",
    });

    try {
      const result = await this.runAgent(message.content, resumeId, emit, model);

      // Cache the new SDK session ID
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // If resume failed, retry without resume
      if (resumeId && /session|conversation/i.test(errMsg)) {
        this.sdkSessionIds.delete(sessionKey);

        emit({
          type: "system",
          subtype: "status",
          message: "Session expired, starting fresh...",
        });

        try {
          const result = await this.runAgent(message.content, undefined, emit, model);

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
  ): Promise<{ text: string; sessionId?: string }> {
    // Auto-approve all tools from our MCP servers
    const allowedTools = Object.keys(this.mcpServers).map((name) => `mcp__${name}`);

    const sdkQuery = runSession({
      prompt,
      model: model ?? this.config.model,
      systemPromptAppend: this.systemPromptAppend,
      mcpServers: this.mcpServers,
      // Daemon runs unattended — no human to approve tool calls.
      // Use bypassPermissions so tools like filesystem search and web search work.
      permissionMode: "bypassPermissions",
      allowedTools,
      resume: resumeId,
      maxTurns: 50,
      anthropicBaseUrl: this.config.anthropicBaseUrl,
    });

    let fullText = "";
    let sessionId: string | undefined;

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
          emit({
            type: "tool_use_summary",
            tool_name: (msg as { tool_name?: string }).tool_name ?? "unknown",
            summary: msg.summary,
          });
          break;
        }

        case "result": {
          sessionId = msg.session_id;
          for (const block of msg.result) {
            if (block.type === "text") {
              fullText += block.text;
            }
          }
          emit({
            type: "result",
            result: msg.result,
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

    return { text: fullText, sessionId };
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
