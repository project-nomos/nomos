import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { handleBootstrapComplete } from "../ui/bootstrap.ts";
import {
  fetchRenderedPage,
  validateUrl,
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserType,
  browserSelect,
  browserEvaluate,
  browserSnapshot,
  closeActivePage,
} from "./browser.ts";

/**
 * Creates an in-process MCP server that exposes memory tools to the agent.
 * The agent can call `memory_search` to query the pgvector-backed memory store.
 */
export function createMemoryMcpServer(): McpSdkServerConfigWithInstance {
  const memorySearchTool = tool(
    "memory_search",
    "Search the long-term memory store using hybrid vector + text search. Returns relevant code snippets, documentation, and previously stored knowledge. Use the category filter for targeted recall.",
    {
      query: z.string().describe("The search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum number of results (default: 5)"),
      category: z
        .enum(["fact", "preference", "correction", "skill", "conversation"])
        .optional()
        .describe("Filter by memory category"),
    },
    async (args) => {
      try {
        const { isEmbeddingAvailable, generateEmbedding } = await import("../memory/embeddings.ts");
        const { hybridSearch, textOnlySearch } = await import("../memory/search.ts");

        let results;

        if (!isEmbeddingAvailable()) {
          // Fall back to text-only search when embeddings are unavailable
          results = await textOnlySearch(args.query, args.limit ?? 5, args.category);
        } else {
          try {
            const embedding = await generateEmbedding(args.query);
            results = await hybridSearch(args.query, embedding, args.limit ?? 5, args.category);
          } catch {
            // Fall back to text-only search if embedding generation fails
            console.warn(
              "\x1b[2mEmbedding generation failed, falling back to text-only search\x1b[0m",
            );
            results = await textOnlySearch(args.query, args.limit ?? 5, args.category);
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found in memory." }],
          };
        }

        const formatted = results
          .map((r, i) => {
            const source = r.path ?? r.source;
            const cat = (r.metadata as Record<string, unknown>)?.category;
            const catLabel = cat ? ` [${cat}]` : "";
            return `[${i + 1}] ${source}${catLabel} (score: ${r.score.toFixed(4)})\n${r.text}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Memory search failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const userModelRecallTool = tool(
    "user_model_recall",
    "Recall what you've learned about the user from past conversations. Returns accumulated preferences, facts, and patterns.",
    {
      category: z.enum(["preference", "fact", "style"]).optional().describe("Filter by category"),
    },
    async (args) => {
      try {
        const { getUserModel } = await import("../db/user-model.ts");
        const entries = await getUserModel(args.category);

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No user model entries found. The user model is built over time from conversations.",
              },
            ],
          };
        }

        const formatted = entries
          .map((e) => {
            const valueStr = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
            return `[${e.category}] ${e.key}: ${valueStr} (confidence: ${e.confidence.toFixed(2)})`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `User Model (${entries.length} entries):\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `User model recall failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const bootstrapCompleteTool = tool(
    "bootstrap_complete",
    "Save agent purpose, user profile, and agent identity after the first-run introduction conversation. Call this once you've discovered your purpose and the user's name.",
    {
      purpose: z
        .string()
        .describe(
          "What this agent is for — a clear, specific description of its role (e.g. 'Full-stack TypeScript coding assistant for a Next.js SaaS app')",
        ),
      user_name: z.string().describe("The user's name"),
      workspace: z.string().optional().describe("What the user is working on"),
      instructions: z
        .string()
        .optional()
        .describe("Communication preferences (e.g. concise, detailed)"),
      agent_name: z.string().optional().describe("Name the user chose for the assistant"),
      agent_emoji: z.string().optional().describe("Emoji the user chose for the assistant"),
    },
    async (args) => {
      try {
        await handleBootstrapComplete(args);

        const parts = [`Identity locked in. Nice to meet you, ${args.user_name}.`];
        parts.push(`My purpose: ${args.purpose}`);
        if (args.agent_name) parts.push(`I'll go by ${args.agent_name}.`);
        if (args.agent_emoji) parts.push(`My emoji: ${args.agent_emoji}`);
        parts.push("This will shape how I work with you from now on.");

        return {
          content: [{ type: "text", text: parts.join(" ") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to save profile: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        // Mark as non-destructive so permission modes don't block it
        readOnly: false,
      },
    },
  );

  const browserFetchTool = tool(
    "browser_fetch",
    "Fetch a web page with full JavaScript rendering using a headless browser. Use this for dynamic/JS-rendered pages (React, Vue, Angular, SPAs). For static HTML pages, prefer the built-in WebFetch tool which is faster.",
    {
      url: z.string().url().describe("The URL to fetch"),
      wait_for_selector: z
        .string()
        .optional()
        .describe('CSS selector to wait for before extracting content (e.g. "#main-content")'),
      wait_for_timeout: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe("Extra milliseconds to wait after page load"),
      timeout: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("Navigation timeout in milliseconds (default: 30000)"),
    },
    async (args) => {
      const urlError = validateUrl(args.url);
      if (urlError) {
        return {
          content: [{ type: "text", text: urlError }],
          isError: true,
        };
      }

      try {
        const result = await fetchRenderedPage(args.url, {
          waitForSelector: args.wait_for_selector,
          waitForTimeout: args.wait_for_timeout,
          timeout: args.timeout,
        });

        const parts: string[] = [];
        if (result.title) parts.push(`# ${result.title}\n`);
        parts.push(result.content);

        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Browser fetch failed: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const checkPermissionTool = tool(
    "check_permission",
    "Check if a permanent permission has been granted for a specific resource and action. Call this BEFORE attempting sensitive operations like accessing files outside CWD or running install commands.",
    {
      resource_type: z
        .enum(["path", "command", "package"])
        .describe("Type of resource: path, command, or package"),
      action: z
        .enum(["read", "write", "execute", "install"])
        .describe("Action to check: read, write, execute, or install"),
      target: z.string().describe("The specific path, command, or package name to check"),
    },
    async (args) => {
      try {
        const { checkPermission } = await import("../db/permissions.ts");
        const result = await checkPermission(args.resource_type, args.action, args.target);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Permission check failed: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const grantPermissionTool = tool(
    "grant_permission",
    'Store a permanent ("always allow") permission. Call this after the user explicitly says "always allow" for an operation. Use trailing * for directory/command prefixes (e.g. "/Users/me/Documents/*", "docker *").',
    {
      resource_type: z
        .enum(["path", "command", "package"])
        .describe("Type of resource: path, command, or package"),
      action: z
        .enum(["read", "write", "execute", "install"])
        .describe("Action to grant: read, write, execute, or install"),
      pattern: z.string().describe("Exact value or glob pattern (trailing *) to allow"),
      granted_by: z
        .string()
        .optional()
        .describe("Who granted the permission (e.g. user name or channel)"),
    },
    async (args) => {
      try {
        const { grantPermission } = await import("../db/permissions.ts");
        await grantPermission(args.resource_type, args.action, args.pattern, args.granted_by);
        return {
          content: [
            {
              type: "text",
              text: `Permission granted: ${args.resource_type}/${args.action} → ${args.pattern}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to grant permission: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const generateImageTool = tool(
    "generate_image",
    "Generate an image from a text prompt using Google's Gemini model. Returns the file path to the generated image. Requires image generation to be enabled and a Gemini API key configured.",
    {
      prompt: z
        .string()
        .describe(
          "Detailed description of the image to generate. Be specific about style, composition, colors, and subject matter.",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Optional file path to save the image. If not provided, saves to a temp directory.",
        ),
    },
    async (args) => {
      try {
        if (process.env.NOMOS_IMAGE_GENERATION !== "true") {
          return {
            content: [
              {
                type: "text",
                text: "Image generation is not enabled. Enable it in Settings or set NOMOS_IMAGE_GENERATION=true and GEMINI_API_KEY in your environment.",
              },
            ],
            isError: true,
          };
        }

        const { generateImage } = await import("./image-gen.ts");
        const result = await generateImage(args.prompt, {
          outputPath: args.output_path,
        });

        const parts = [`Image saved to: ${result.imagePath}`];
        if (result.text) {
          parts.push(`\nModel notes: ${result.text}`);
        }

        return {
          content: [{ type: "text", text: parts.join("") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Image generation failed: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const generateVideoTool = tool(
    "generate_video",
    "Generate a video from a text prompt using Google's Veo model. This is a long-running operation that may take a few minutes. Returns the file path to the generated video. Requires video generation to be enabled and a Gemini API key configured.",
    {
      prompt: z
        .string()
        .describe(
          "Detailed description of the video to generate. Describe the scene, action, camera movement, style, and mood.",
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Optional file path to save the video. If not provided, saves to a temp directory.",
        ),
      duration_seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Duration of the video in seconds (default determined by model)"),
    },
    async (args) => {
      try {
        if (process.env.NOMOS_VIDEO_GENERATION !== "true") {
          return {
            content: [
              {
                type: "text",
                text: "Video generation is not enabled. Enable it in Settings or set NOMOS_VIDEO_GENERATION=true and GEMINI_API_KEY in your environment.",
              },
            ],
            isError: true,
          };
        }

        const { generateVideo } = await import("./video-gen.ts");
        const result = await generateVideo(args.prompt, {
          outputPath: args.output_path,
          durationSeconds: args.duration_seconds,
        });

        return {
          content: [{ type: "text", text: `Video saved to: ${result.videoPath}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Video generation failed: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const revokePermissionTool = tool(
    "revoke_permission",
    "Remove a previously granted permanent permission.",
    {
      resource_type: z
        .enum(["path", "command", "package"])
        .describe("Type of resource: path, command, or package"),
      action: z
        .enum(["read", "write", "execute", "install"])
        .describe("Action to revoke: read, write, execute, or install"),
      pattern: z.string().describe("The exact pattern that was granted"),
    },
    async (args) => {
      try {
        const { revokePermission } = await import("../db/permissions.ts");
        const removed = await revokePermission(args.resource_type, args.action, args.pattern);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `Permission revoked: ${args.resource_type}/${args.action} → ${args.pattern}`
                : `No matching permission found for: ${args.resource_type}/${args.action} → ${args.pattern}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to revoke permission: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const scheduleTaskTool = tool(
    "schedule_task",
    "Create a scheduled background task that runs automatically in the daemon. Use this when the user asks for recurring checks, periodic actions, or timed tasks. The task prompt is executed by the agent on schedule. Schedule types: 'every' for intervals (e.g. '15m', '1h', '2d'), 'cron' for cron expressions (e.g. '0 9 * * 1-5' for weekday mornings), 'at' for one-time execution at a specific time (ISO 8601).",
    {
      name: z.string().describe("Short descriptive name for the task (e.g. 'check-urgent-emails')"),
      prompt: z
        .string()
        .describe(
          "The instruction the agent will execute on each run (e.g. 'Check my Gmail for urgent unread emails and summarize them')",
        ),
      schedule: z
        .string()
        .describe(
          "Schedule string: interval like '15m'/'1h'/'2d', cron expression like '0 9 * * 1-5', or ISO timestamp for one-time",
        ),
      schedule_type: z
        .enum(["every", "cron", "at"])
        .describe(
          "Type of schedule: 'every' for intervals, 'cron' for cron expressions, 'at' for one-time",
        ),
      platform: z
        .string()
        .optional()
        .describe("Platform to deliver results to (e.g. 'slack', 'discord', 'telegram')"),
      channel_id: z.string().optional().describe("Channel/chat ID to deliver results to"),
      announce: z
        .boolean()
        .optional()
        .describe("Whether to send the result to the specified channel (default: false)"),
    },
    async (args) => {
      try {
        const { getDb } = await import("../db/client.ts");
        const { CronStore } = await import("../cron/store.ts");

        // Resolve platform/channelId from default notification channel if not provided
        let platform = args.platform;
        let channelId = args.channel_id;

        if (args.announce && (!platform || !channelId)) {
          const { getNotificationDefault } = await import("../db/notification-defaults.ts");
          const nd = await getNotificationDefault();
          if (nd) {
            platform = platform ?? nd.platform;
            channelId = channelId ?? nd.channelId;
          }
        }

        const store = new CronStore(getDb());
        const id = await store.createJob({
          name: args.name,
          prompt: args.prompt,
          schedule: args.schedule,
          scheduleType: args.schedule_type,
          sessionTarget: "isolated",
          deliveryMode: args.announce && platform && channelId ? "announce" : "none",
          platform,
          channelId,
          enabled: true,
          errorCount: 0,
        });

        // Notify cron engine to refresh (if running in daemon)
        try {
          process.emit("cron:refresh" as never);
        } catch {
          // Not in daemon context — scheduler will pick it up on next poll
        }

        const scheduleDesc =
          args.schedule_type === "every"
            ? `every ${args.schedule}`
            : args.schedule_type === "cron"
              ? `cron: ${args.schedule}`
              : `once at ${args.schedule}`;

        const deliverTo =
          args.announce && platform && channelId ? `\n  Delivers to: ${platform}/${channelId}` : "";

        return {
          content: [
            {
              type: "text",
              text: `Scheduled task created:\n  ID: ${id.slice(0, 8)}\n  Name: ${args.name}\n  Schedule: ${scheduleDesc}\n  Prompt: ${args.prompt}${deliverTo}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to create scheduled task: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const listScheduledTasksTool = tool(
    "list_scheduled_tasks",
    "List all scheduled background tasks. Shows active and disabled tasks with their schedules and last run status.",
    {
      include_disabled: z.boolean().optional().describe("Include disabled tasks (default: false)"),
    },
    async (args) => {
      try {
        const { getDb } = await import("../db/client.ts");
        const { CronStore } = await import("../cron/store.ts");

        const store = new CronStore(getDb());
        const jobs = await store.listJobs(args.include_disabled ? undefined : { enabled: true });

        if (jobs.length === 0) {
          return {
            content: [{ type: "text", text: "No scheduled tasks found." }],
          };
        }

        const formatted = jobs
          .map((j) => {
            const scheduleDesc =
              j.scheduleType === "every"
                ? `every ${j.schedule}`
                : j.scheduleType === "cron"
                  ? `cron: ${j.schedule}`
                  : `at ${j.schedule}`;
            const status = j.enabled ? "active" : "disabled";
            const lastRun = j.lastRun ? `last run: ${j.lastRun.toISOString()}` : "never run";
            const errorInfo = j.errorCount > 0 ? ` (${j.errorCount} errors)` : "";
            return `- ${j.name} [${status}]\n  ID: ${j.id.slice(0, 8)}\n  Schedule: ${scheduleDesc}\n  Prompt: ${j.prompt}\n  ${lastRun}${errorInfo}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Scheduled Tasks (${jobs.length}):\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to list tasks: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const deleteScheduledTaskTool = tool(
    "delete_scheduled_task",
    "Delete a scheduled background task by ID or name.",
    {
      id: z.string().optional().describe("Task ID (full or first 8 chars)"),
      name: z.string().optional().describe("Task name (exact match)"),
    },
    async (args) => {
      try {
        if (!args.id && !args.name) {
          return {
            content: [{ type: "text", text: "Provide either task ID or name to delete." }],
            isError: true,
          };
        }

        const { getDb } = await import("../db/client.ts");
        const { CronStore } = await import("../cron/store.ts");

        const store = new CronStore(getDb());
        let job = null;

        if (args.name) {
          job = await store.getJobByName(args.name);
        }

        if (!job && args.id) {
          // Try exact match first
          job = await store.getJob(args.id);

          // Try prefix match if short ID given
          if (!job && args.id.length < 36) {
            const allJobs = await store.listJobs();
            job = allJobs.find((j) => j.id.startsWith(args.id!)) ?? null;
          }
        }

        if (!job) {
          return {
            content: [
              {
                type: "text",
                text: `No task found with ${args.name ? `name "${args.name}"` : `ID "${args.id}"`}`,
              },
            ],
            isError: true,
          };
        }

        await store.deleteJob(job.id);

        // Notify cron engine to refresh
        try {
          process.emit("cron:refresh" as never);
        } catch {
          // Not in daemon context
        }

        return {
          content: [
            {
              type: "text",
              text: `Deleted scheduled task: ${job.name} (${job.id.slice(0, 8)})`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to delete task: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const switchGoogleAccountTool = tool(
    "switch_google_account",
    "Switch the active Google Workspace account. Use this before making Google API calls (Gmail, Drive, Calendar, etc.) when the user wants to access a different account.",
    {
      email: z.string().email().describe("The email address of the account to switch to"),
    },
    async (args) => {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        await execFileAsync("npx", ["gws", "auth", "default", args.email], { timeout: 10000 });

        return {
          content: [
            {
              type: "text",
              text: `Switched default Google account to ${args.email}. Subsequent Google Workspace API calls will use this account.`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to switch Google account: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: false,
      },
    },
  );

  const listGoogleAccountsTool = tool(
    "list_google_accounts",
    "List all authorized Google Workspace accounts. Shows which account is currently the default.",
    {},
    async () => {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
        const data = JSON.parse(stdout);

        if (!data.accounts || data.accounts.length === 0) {
          return {
            content: [{ type: "text", text: "No Google accounts authorized." }],
          };
        }

        const formatted = data.accounts
          .map((entry: string | { email: string }) => {
            const email = typeof entry === "string" ? entry : entry.email;
            const isDefault = email === data.default;
            return `- ${email}${isDefault ? " (default/active)" : ""}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Google Workspace accounts (${data.count}):\n${formatted}\n\nUse switch_google_account to change the active account.`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to list accounts: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const checkForUpdatesTool = tool(
    "check_for_updates",
    "Check if a newer version of Nomos is available. Compares the installed version against the latest GitHub release. Use this proactively to inform the user about available upgrades.",
    {},
    async () => {
      try {
        const { getInstalledVersion, getLatestVersion, isNewerVersion } =
          await import("../config/version.ts");
        const current = getInstalledVersion();
        const latest = await getLatestVersion();

        if (!latest) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Installed version: v${current}\nCould not check for updates (offline or rate-limited).`,
              },
            ],
          };
        }

        if (isNewerVersion(current, latest)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Update available! v${current} → v${latest}\nUpgrade with: brew upgrade nomos`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Nomos is up to date (v${current}).`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to check for updates: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  // ── Interactive Browser Control Tools ──

  const browserNavigateTool = tool(
    "browser_navigate",
    "Navigate the interactive browser to a URL. Opens a persistent browser session that stays open across tool calls. Use this for multi-step web interactions (login flows, form filling, scraping dynamic content).",
    {
      url: z.string().url().describe("The URL to navigate to"),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .optional()
        .describe("When to consider navigation done (default: networkidle)"),
    },
    async (args) => {
      const urlError = validateUrl(args.url);
      if (urlError) return { content: [{ type: "text", text: urlError }], isError: true };
      try {
        const result = await browserNavigate(args.url, { waitUntil: args.wait_until });
        return {
          content: [{ type: "text", text: `Navigated to: ${result.url}\nTitle: ${result.title}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Navigation failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  const browserScreenshotTool = tool(
    "browser_screenshot",
    "Take a screenshot of the current browser page. Returns a base64 PNG image for visual analysis. Use after navigating to verify page state, inspect layout, or debug visual issues.",
    {
      full_page: z
        .boolean()
        .optional()
        .describe("Capture the full scrollable page (default: viewport only)"),
      selector: z.string().optional().describe("CSS selector to screenshot a specific element"),
    },
    async (args) => {
      try {
        const result = await browserScreenshot({
          fullPage: args.full_page,
          selector: args.selector,
        });
        return {
          content: [
            {
              type: "image",
              data: result.base64,
              mimeType: "image/png",
            } as unknown as { type: "text"; text: string },
            {
              type: "text",
              text: `Screenshot captured (${result.width}x${result.height})`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Screenshot failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  const browserClickTool = tool(
    "browser_click",
    "Click an element on the current browser page. Use CSS selectors to target elements. Works with buttons, links, checkboxes, and any clickable element.",
    {
      selector: z
        .string()
        .describe(
          "CSS selector of the element to click (e.g. '#submit-btn', 'button.primary', 'a[href=\"/login\"]')",
        ),
      button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button (default: left)"),
      click_count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Number of clicks (default: 1, use 2 for double-click)"),
    },
    async (args) => {
      try {
        const result = await browserClick(args.selector, {
          button: args.button,
          clickCount: args.click_count,
        });
        const textInfo = result.text ? ` — element text: "${result.text}"` : "";
        return { content: [{ type: "text", text: `Clicked: ${args.selector}${textInfo}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Click failed: ${message}` }], isError: true };
      }
    },
  );

  const browserTypeTool = tool(
    "browser_type",
    "Type text into an input field on the current browser page. Can optionally clear the field first and press Enter after typing.",
    {
      selector: z.string().describe("CSS selector of the input element"),
      text: z.string().describe("Text to type"),
      clear: z.boolean().optional().describe("Clear the field before typing (default: false)"),
      press_enter: z.boolean().optional().describe("Press Enter after typing (default: false)"),
    },
    async (args) => {
      try {
        await browserType(args.selector, args.text, {
          clear: args.clear,
          pressEnter: args.press_enter,
        });
        return {
          content: [
            {
              type: "text",
              text: `Typed "${args.text.slice(0, 50)}${args.text.length > 50 ? "..." : ""}" into ${args.selector}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Type failed: ${message}` }], isError: true };
      }
    },
  );

  const browserSelectTool = tool(
    "browser_select",
    "Select option(s) from a <select> dropdown on the current browser page.",
    {
      selector: z.string().describe("CSS selector of the <select> element"),
      values: z.array(z.string()).describe("Option value(s) to select"),
    },
    async (args) => {
      try {
        const result = await browserSelect(args.selector, args.values);
        return { content: [{ type: "text", text: `Selected: ${result.selected.join(", ")}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Select failed: ${message}` }], isError: true };
      }
    },
  );

  const browserEvaluateTool = tool(
    "browser_evaluate",
    "Execute JavaScript in the current browser page context. Use for extracting data, manipulating DOM, or checking page state. Returns the serialized result.",
    {
      expression: z.string().describe("JavaScript expression to evaluate in the page context"),
    },
    async (args) => {
      try {
        const result = await browserEvaluate(args.expression);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text: text ?? "(undefined)" }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Evaluate failed: ${message}` }], isError: true };
      }
    },
  );

  const browserSnapshotTool = tool(
    "browser_snapshot",
    "Get a structured snapshot of the current browser page: visible text content and all interactive elements (buttons, links, inputs) with their selectors. Use this to understand page structure before clicking or typing.",
    {},
    async () => {
      try {
        const snapshot = await browserSnapshot();
        const elementsText = snapshot.elements
          .map((e) => `  [${e.tag}${e.type ? `:${e.type}` : ""}] "${e.text}" → ${e.selector}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: [
                `URL: ${snapshot.url}`,
                `Title: ${snapshot.title}`,
                `\n--- Page Text (truncated) ---\n${snapshot.text.slice(0, 3000)}`,
                `\n--- Interactive Elements (${snapshot.elements.length}) ---\n${elementsText}`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Snapshot failed: ${message}` }], isError: true };
      }
    },
    { annotations: { readOnly: true } },
  );

  const browserCloseTool = tool(
    "browser_close",
    "Close the current interactive browser session. Use when done with browser automation to free resources.",
    {},
    async () => {
      await closeActivePage();
      return { content: [{ type: "text", text: "Browser session closed." }] };
    },
  );

  // ── Task Management Tools ──

  const taskStatusTool = tool(
    "task_status",
    "List running and recent daemon tasks. Shows background agent tasks, cron job executions, and team worker status with their IDs for management.",
    {
      task_id: z.string().optional().describe("Get details for a specific task (full or short ID)"),
      active_only: z
        .boolean()
        .optional()
        .describe("Only show active (pending/running) tasks (default: false)"),
    },
    async (args) => {
      try {
        const { getTaskManager } = await import("../daemon/task-manager.ts");
        const tm = getTaskManager();

        if (args.task_id) {
          const task = tm.get(args.task_id) ?? tm.getByPrefix(args.task_id);
          if (!task) {
            return {
              content: [{ type: "text", text: `No task found with ID: ${args.task_id}` }],
              isError: true,
            };
          }
          const duration = task.durationMs ? ` (${(task.durationMs / 1000).toFixed(1)}s)` : "";
          const error = task.error ? `\n  Error: ${task.error}` : "";
          const deps = task.blockedBy?.length
            ? `\n  Blocked by: ${task.blockedBy.map((id: string) => id.slice(0, 8)).join(", ")}`
            : "";
          const blocks = task.blocks?.length
            ? `\n  Blocks: ${task.blocks.map((id: string) => id.slice(0, 8)).join(", ")}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Task: ${task.name} [${task.status}]${duration}\n  ID: ${task.id.slice(0, 8)}\n  Source: ${task.source}\n  Description: ${task.description}${deps}${blocks}${error}`,
              },
            ],
          };
        }

        const tasks = args.active_only ? tm.listActive() : tm.listAll();
        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "No tasks found." }] };
        }

        const formatted = tasks
          .map((t) => {
            const duration = t.durationMs ? ` (${(t.durationMs / 1000).toFixed(1)}s)` : "";
            const error = t.error ? ` — ${t.error}` : "";
            return `- ${t.name} [${t.status}]${duration}\n  ID: ${t.id.slice(0, 8)} | Source: ${t.source}${error}`;
          })
          .join("\n\n");

        return { content: [{ type: "text", text: `Tasks (${tasks.length}):\n\n${formatted}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Task status failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  const taskKillTool = tool(
    "task_kill",
    "Kill a running daemon task by ID. Sends an abort signal to stop the task. Use task_status first to find the task ID.",
    {
      task_id: z.string().describe("Task ID to kill (full UUID or first 8 chars)"),
    },
    async (args) => {
      try {
        const { getTaskManager } = await import("../daemon/task-manager.ts");
        const tm = getTaskManager();

        let killed = tm.kill(args.task_id);
        if (!killed) {
          // Try prefix match
          const task = tm.getByPrefix(args.task_id);
          if (task) {
            killed = tm.kill(task.id);
          }
        }

        if (!killed) {
          return {
            content: [{ type: "text", text: `No active task found with ID: ${args.task_id}` }],
            isError: true,
          };
        }

        return { content: [{ type: "text", text: `Task killed: ${args.task_id.slice(0, 8)}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Task kill failed: ${message}` }], isError: true };
      }
    },
  );

  // ── Memory Consolidation Tool ──

  const memoryConsolidateTool = tool(
    "memory_consolidate",
    "Run memory consolidation: merge near-duplicate chunks, prune stale low-access entries, and decay outdated user model confidence. Use periodically to keep memory clean and relevant. Can also be scheduled as a cron job.",
    {},
    async () => {
      try {
        const { consolidateMemory } = await import("../memory/consolidator.ts");
        const result = await consolidateMemory();
        return {
          content: [
            {
              type: "text",
              text: [
                `Memory consolidation complete:`,
                `  Merged: ${result.merged} duplicate chunks`,
                `  Pruned: ${result.pruned} stale chunks`,
                `  Rewritten: ${result.rewritten} chunks (LLM review)`,
                `  Total: ${result.totalBefore} → ${result.totalAfter} chunks`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Memory consolidation failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Sleep / Self-Resume Tool ──

  const sleepTool = tool(
    "agent_sleep",
    "Sleep for a specified duration, then wake up and continue. Use this when you need to wait before checking something (e.g., wait for a deployment, poll for results, periodic monitoring within a session). The agent pauses without consuming resources and resumes with a wake-up prompt. Max sleep: 1 hour.",
    {
      duration_seconds: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .describe("How long to sleep in seconds (5–3600)"),
      wake_prompt: z
        .string()
        .describe(
          "Instruction to execute when waking up (e.g., 'Check if the build completed and report status')",
        ),
      reason: z.string().optional().describe("Why the agent is sleeping (logged for context)"),
    },
    async (args) => {
      return new Promise((resolve) => {
        const startTime = Date.now();
        const timer = setTimeout(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          resolve({
            content: [
              {
                type: "text",
                text: [
                  `⏰ Woke up after ${elapsed}s sleep.`,
                  args.reason ? `Sleep reason: ${args.reason}` : "",
                  `\nWake-up task: ${args.wake_prompt}`,
                  `\nPlease execute the wake-up task now.`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ],
          });
        }, args.duration_seconds * 1000);

        // Allow abort to cancel the sleep
        if (typeof globalThis !== "undefined") {
          const cleanup = () => {
            clearTimeout(timer);
            resolve({
              content: [
                {
                  type: "text",
                  text: `Sleep interrupted after ${((Date.now() - startTime) / 1000).toFixed(0)}s. Wake-up task: ${args.wake_prompt}`,
                },
              ],
            });
          };
          process.once("agent:wake", cleanup);
          // Clean up listener if timer fires normally
          setTimeout(
            () => process.removeListener("agent:wake", cleanup),
            args.duration_seconds * 1000 + 100,
          );
        }
      });
    },
  );

  // ── Plan Mode Tool ──

  const proposePlanTool = tool(
    "propose_plan",
    "Propose an implementation plan for the user to review before execution. Use this for complex, multi-step tasks where you want to align with the user before making changes. The plan is stored and the user can approve, modify, or reject it. Only propose plans for significant changes — don't use this for simple tasks.",
    {
      title: z.string().describe("Short title for the plan (e.g., 'Refactor auth middleware')"),
      summary: z.string().describe("1-2 sentence summary of what will be done and why"),
      steps: z
        .array(
          z.object({
            description: z.string().describe("What this step does"),
            files: z
              .array(z.string())
              .optional()
              .describe("Files that will be created or modified"),
            risk: z.enum(["low", "medium", "high"]).optional().describe("Risk level of this step"),
          }),
        )
        .describe("Ordered list of implementation steps"),
      alternatives_considered: z
        .string()
        .optional()
        .describe(
          "Brief note on alternatives that were considered and why this approach was chosen",
        ),
    },
    async (args) => {
      // Store the plan for later reference
      const planId = `plan-${Date.now()}`;
      const planText = [
        `# ${args.title}`,
        "",
        args.summary,
        "",
        "## Steps",
        ...args.steps.map((step, i) => {
          const files = step.files?.length ? ` (${step.files.join(", ")})` : "";
          const risk = step.risk ? ` [${step.risk} risk]` : "";
          return `${i + 1}. ${step.description}${files}${risk}`;
        }),
        ...(args.alternatives_considered
          ? ["", "## Alternatives Considered", args.alternatives_considered]
          : []),
        "",
        `Plan ID: ${planId}`,
        "Reply with 'approved', 'modify', or 'reject' to proceed.",
      ].join("\n");

      // Store plan in memory for retrieval
      try {
        const { getDb } = await import("../db/client.ts");
        const sql = getDb();
        await sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${`plan.${planId}`}, ${JSON.stringify({ title: args.title, steps: args.steps, summary: args.summary })}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
      } catch {
        // Non-critical — plan is returned inline anyway
      }

      return {
        content: [{ type: "text", text: planText }],
      };
    },
    { annotations: { readOnly: true } },
  );

  // ── LSP Code Intelligence Tools ──

  const lspGoToDefinitionTool = tool(
    "lsp_go_to_definition",
    "Jump to the definition of a symbol (function, class, variable, type) at a specific position in a TypeScript/JavaScript file. Returns the file path and line number where the symbol is defined. Useful for understanding where something is implemented.",
    {
      file: z.string().describe("Path to the file containing the symbol"),
      line: z.number().int().min(1).describe("Line number (1-based)"),
      character: z.number().int().min(0).describe("Column/character offset (0-based)"),
    },
    async (args) => {
      try {
        const { goToDefinition } = await import("./lsp.ts");
        const results = await goToDefinition(args.file, args.line, args.character);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No definition found at that position." }] };
        }

        const formatted = results.map((r) => `${r.path}:${r.line}:${r.character}`).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Definition${results.length > 1 ? "s" : ""} found:\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Go-to-definition failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  const lspFindReferencesTool = tool(
    "lsp_find_references",
    "Find all references to a symbol at a specific position in a TypeScript/JavaScript file. Returns every location where the symbol is used across the project. Useful for understanding impact before refactoring.",
    {
      file: z.string().describe("Path to the file containing the symbol"),
      line: z.number().int().min(1).describe("Line number (1-based)"),
      character: z.number().int().min(0).describe("Column/character offset (0-based)"),
      include_declaration: z
        .boolean()
        .optional()
        .describe("Include the declaration itself in results (default: true)"),
    },
    async (args) => {
      try {
        const { findReferences } = await import("./lsp.ts");
        const results = await findReferences(
          args.file,
          args.line,
          args.character,
          args.include_declaration ?? true,
        );

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No references found." }] };
        }

        const formatted = results.map((r) => `${r.path}:${r.line}:${r.character}`).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${results.length} reference${results.length > 1 ? "s" : ""} found:\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Find-references failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  const lspHoverTool = tool(
    "lsp_hover",
    "Get type information and documentation for a symbol at a specific position. Returns the inferred type signature and any JSDoc comments. Use this to understand what a variable/function is without reading the definition.",
    {
      file: z.string().describe("Path to the file containing the symbol"),
      line: z.number().int().min(1).describe("Line number (1-based)"),
      character: z.number().int().min(0).describe("Column/character offset (0-based)"),
    },
    async (args) => {
      try {
        const { hover } = await import("./lsp.ts");
        const result = await hover(args.file, args.line, args.character);

        if (!result) {
          return { content: [{ type: "text", text: "No hover information available." }] };
        }

        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Hover failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  const lspDocumentSymbolsTool = tool(
    "lsp_document_symbols",
    "Get all symbols (functions, classes, interfaces, variables, etc.) defined in a file. Returns a hierarchical list with symbol names, kinds, and line numbers. Use this for a quick overview of a file's structure.",
    {
      file: z.string().describe("Path to the TypeScript/JavaScript file"),
    },
    async (args) => {
      try {
        const { documentSymbols } = await import("./lsp.ts");
        const symbols = await documentSymbols(args.file);

        if (symbols.length === 0) {
          return { content: [{ type: "text", text: "No symbols found in file." }] };
        }

        function formatSymbol(
          sym: { name: string; kind: string; line: number; endLine: number; children?: unknown[] },
          indent = 0,
        ): string {
          const prefix = "  ".repeat(indent);
          let line = `${prefix}[${sym.kind}] ${sym.name} (L${sym.line}–${sym.endLine})`;
          if (sym.children) {
            for (const child of sym.children as typeof symbols) {
              line += "\n" + formatSymbol(child, indent + 1);
            }
          }
          return line;
        }

        const formatted = symbols.map((s) => formatSymbol(s)).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${symbols.length} top-level symbol${symbols.length > 1 ? "s" : ""}:\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Document symbols failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  // ── Proactive Message Delivery Helper ──

  /**
   * Deliver a proactive message via the daemon's channel manager.
   * Uses a process event so the gateway can route it through the correct adapter.
   * Falls back to direct adapter lookup if running in-process.
   */
  async function deliverProactiveMessage(
    platform: string,
    channelId: string,
    content: string,
  ): Promise<boolean> {
    // Emit event for gateway to pick up
    const delivered = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);

      const handler = (result: boolean) => {
        clearTimeout(timeout);
        resolve(result);
      };

      // The gateway listens for this event and routes via channel manager
      process.emit(
        "proactive:send" as never,
        { platform, channelId, content, callback: handler } as never,
      );

      // If no listener registered (not in daemon), resolve false after short delay
      if (process.listenerCount("proactive:send" as never) === 0) {
        clearTimeout(timeout);
        resolve(false);
      }
    });

    return delivered;
  }

  // ── Proactive Message Tool ──

  const proactiveSendTool = tool(
    "proactive_send",
    "Send a proactive message to the user's notification channel without being asked. Use this when you detect something important the user should know about: urgent emails, build failures, monitoring alerts, scheduled task results, or anything time-sensitive. If no target is specified, uses the default notification channel.",
    {
      message: z.string().describe("The message content to send to the user"),
      platform: z
        .string()
        .optional()
        .describe(
          "Target platform (e.g., 'slack-user:T074HACEZ2L'). If omitted, uses default notification channel.",
        ),
      channel_id: z
        .string()
        .optional()
        .describe("Target channel/user ID. If omitted, uses default notification channel."),
      urgency: z
        .enum(["info", "warning", "urgent"])
        .optional()
        .describe("Urgency level — affects message formatting (default: info)"),
    },
    async (args) => {
      try {
        const { resolveDefaultTarget } = await import("../daemon/proactive-sender.ts");

        let platform = args.platform;
        let channelId = args.channel_id;

        // Resolve from default if not explicitly provided
        if (!platform || !channelId) {
          const defaultTarget = await resolveDefaultTarget();
          if (!defaultTarget) {
            return {
              content: [
                {
                  type: "text",
                  text: "No target specified and no default notification channel configured. Ask the user to set one in Settings.",
                },
              ],
              isError: true,
            };
          }
          platform = platform ?? defaultTarget.platform;
          channelId = channelId ?? defaultTarget.channelId;
        }

        // Format with urgency prefix
        let formattedMessage = args.message;
        if (args.urgency === "warning") {
          formattedMessage = `*Warning:* ${args.message}`;
        } else if (args.urgency === "urgent") {
          formattedMessage = `*URGENT:* ${args.message}`;
        }

        // Use channel adapter to deliver
        // The daemon gateway holds the channel manager — we emit a process event
        // that the gateway picks up and routes through the adapter
        const delivered = await deliverProactiveMessage(platform!, channelId!, formattedMessage);

        if (delivered) {
          return {
            content: [
              {
                type: "text",
                text: `Proactive message sent to ${platform}/${channelId}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Message queued for delivery to ${platform}/${channelId} (adapter may not be active)`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Proactive send failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Inter-Agent Messaging Tool ──

  const sendWorkerMessageTool = tool(
    "send_worker_message",
    "Send a message to another team worker or the coordinator during multi-agent team execution. Use this for inter-agent communication when workers need to share intermediate results, request information from siblings, or report blocking issues to the coordinator.",
    {
      to: z
        .string()
        .describe("Target agent: 'coordinator' for the lead agent, or a worker name/ID"),
      message: z.string().describe("The message content to send"),
      priority: z
        .enum(["normal", "urgent", "blocking"])
        .optional()
        .describe(
          "Message priority (default: normal). Use 'blocking' if you can't proceed without a response",
        ),
    },
    async (args) => {
      try {
        const { getTeamMailbox } = await import("../daemon/team-mailbox.ts");
        const mailbox = getTeamMailbox();
        mailbox.send(args.to, args.message, args.priority ?? "normal");
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${args.to}${args.priority === "blocking" ? " [BLOCKING]" : ""}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to send message: ${message}` }],
          isError: true,
        };
      }
    },
  );

  const checkWorkerMessagesTool = tool(
    "check_worker_messages",
    "Check for incoming messages from other team agents. Call this periodically during team execution to see if the coordinator or sibling workers have sent updates, requests, or instructions.",
    {
      from: z.string().optional().describe("Filter messages from a specific agent"),
    },
    async (args) => {
      try {
        const { getTeamMailbox } = await import("../daemon/team-mailbox.ts");
        const mailbox = getTeamMailbox();
        const messages = mailbox.receive(args.from);

        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No new messages." }] };
        }

        const formatted = messages
          .map(
            (m) =>
              `[${m.priority}] From ${m.from}: ${m.message}${m.timestamp ? ` (${new Date(m.timestamp).toISOString()})` : ""}`,
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: `${messages.length} message(s):\n\n${formatted}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to check messages: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } },
  );

  const switchModeTool = tool(
    "switch_permission_mode",
    "Switch the agent's permission mode at runtime. Use 'plan' mode when you want to propose changes without executing them, 'acceptEdits' to auto-accept file edits, or 'bypassPermissions' to skip all checks. The mode change takes effect on the next tool call.",
    {
      mode: z
        .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
        .describe("The permission mode to switch to"),
      reason: z.string().optional().describe("Why the mode is being switched (for audit trail)"),
    },
    async (args) => {
      const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
      if (!validModes.includes(args.mode)) {
        return {
          content: [{ type: "text" as const, text: `Invalid mode: ${args.mode}` }],
          isError: true,
        };
      }

      // Emit event for the REPL to pick up
      process.emit("nomos:mode_change" as never, args.mode as never);

      const reason = args.reason ? ` (reason: ${args.reason})` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Permission mode switched to: ${args.mode}${reason}. The new mode will apply to subsequent tool calls.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "nomos-memory",
    version: "0.1.0",
    tools: [
      memorySearchTool,
      userModelRecallTool,
      bootstrapCompleteTool,
      browserFetchTool,
      generateImageTool,
      generateVideoTool,
      checkPermissionTool,
      grantPermissionTool,
      revokePermissionTool,
      scheduleTaskTool,
      listScheduledTasksTool,
      deleteScheduledTaskTool,
      switchGoogleAccountTool,
      listGoogleAccountsTool,
      checkForUpdatesTool,
      // Interactive browser
      browserNavigateTool,
      browserScreenshotTool,
      browserClickTool,
      browserTypeTool,
      browserSelectTool,
      browserEvaluateTool,
      browserSnapshotTool,
      browserCloseTool,
      // Task management
      taskStatusTool,
      taskKillTool,
      // Memory consolidation
      memoryConsolidateTool,
      // Sleep / self-resume
      sleepTool,
      // Proactive messaging
      proactiveSendTool,
      // Inter-agent messaging
      sendWorkerMessageTool,
      checkWorkerMessagesTool,
      // Plan mode
      proposePlanTool,
      // LSP code intelligence
      lspGoToDefinitionTool,
      lspFindReferencesTool,
      lspHoverTool,
      lspDocumentSymbolsTool,
      // Permission mode switching
      switchModeTool,
    ],
  });
}
