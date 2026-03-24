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
          } catch (embeddingError) {
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
    ],
  });
}
