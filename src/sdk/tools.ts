import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { handleBootstrapComplete } from "../ui/bootstrap.ts";
import { fetchRenderedPage, validateUrl } from "./browser.ts";

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

        const store = new CronStore(getDb());
        const id = await store.createJob({
          name: args.name,
          prompt: args.prompt,
          schedule: args.schedule,
          scheduleType: args.schedule_type,
          sessionTarget: "isolated",
          deliveryMode: args.announce && args.platform && args.channel_id ? "announce" : "none",
          platform: args.platform,
          channelId: args.channel_id,
          enabled: true,
          errorCount: 0,
        });

        // Notify cron engine to refresh (if running in daemon)
        try {
          const { EventEmitter } = await import("node:events");
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

        return {
          content: [
            {
              type: "text",
              text: `Scheduled task created:\n  ID: ${id.slice(0, 8)}\n  Name: ${args.name}\n  Schedule: ${scheduleDesc}\n  Prompt: ${args.prompt}${args.announce ? `\n  Delivers to: ${args.platform}/${args.channel_id}` : ""}`,
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
    ],
  });
}
