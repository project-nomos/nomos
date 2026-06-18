/**
 * `ask_user` MCP tool — lightweight multi-choice question.
 *
 * The agent calls this when it needs a quick decision from the user
 * (which approach, which file, which calendar slot, etc.). The tool
 * uses the MCP elicitation protocol: it calls `extra.sendRequest` with
 * an `elicitation/create` payload; the Claude Agent SDK relays the
 * request to our `onElicitation` callback
 * (see `src/daemon/elicitation-manager.ts`), which renders the question
 * on the user's active channel and waits for an answer.
 *
 * Modeled on Claude Code's own `AskUserQuestion` built-in but routed
 * through Nomos's channel layer so the same agent can ask via Slack
 * buttons, iMessage text, CLI prompt, etc.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("ask-user-tool");

const ASK_USER_DESCRIPTION = `Ask the user a multiple-choice question. The user sees the options on whatever channel they're talking to you in (Slack buttons, a numbered prompt elsewhere) and picks one.

Use this for:
- Quick decisions that meaningfully change what you do next (which approach, which file, which option).
- Confirming destructive or hard-to-reverse actions.
- Resolving ambiguity when the user's intent could go multiple ways.

Don't use this for:
- Yes/no questions you can ask in plain prose ("Should I proceed?").
- Open-ended input (free-text responses are better as a normal message).
- Information you can look up yourself.

The returned value is the label string of whichever option the user picked. If the user cancels or doesn't answer within ~10 minutes, the tool resolves with a "user did not answer" message and you should continue without that input or stop and explain.`;

export interface AskUserToolOptions {
  /**
   * Format hint for option preview content. Mirrors the SDK's
   * `ToolConfig.askUserQuestion.previewFormat`.
   */
  previewFormat?: "markdown" | "html";
  /**
   * Host elicitation callback. When provided, `ask_user` routes the question
   * through this (which calls the ElicitationManager directly) INSTEAD of the
   * SDK's `extra.sendRequest`. The SDK does not forward `elicitation/create`
   * from in-process MCP servers — it answers `-32601 Method not found` — so for
   * the daemon's own tools this direct callback is the only working path.
   */
  elicit?: (
    request: unknown,
    opts: { signal?: AbortSignal },
  ) => Promise<{ action: string; content?: Record<string, unknown> }>;
}

/**
 * Build the `ask_user` tool. Keep it as a factory so the host can
 * inject preview-format hints, etc. Returns the value of `tool(...)`
 * directly so the generic input/arg types stay inferred — the SDK
 * accepts heterogeneous `SdkMcpToolDefinition<...>` values in its
 * tools array.
 */
export function createAskUserTool(options: AskUserToolOptions = {}) {
  return tool(
    "ask_user",
    ASK_USER_DESCRIPTION,
    {
      question: z
        .string()
        .min(3)
        .describe(
          "The complete question shown to the user. Clear, specific, ends with a question mark. Example: 'Which calendar should I add this meeting to?'",
        ),
      options: z
        .array(
          z.object({
            label: z
              .string()
              .min(1)
              .max(75)
              .describe(
                "Short button label (1-5 words). Shown on Slack buttons and as the numbered choice elsewhere.",
              ),
            description: z
              .string()
              .optional()
              .describe("One-sentence elaboration. Optional but helpful when options are close."),
          }),
        )
        .min(2)
        .max(4)
        .describe(
          "Mutually exclusive choices. 2-4 options. Don't include an 'Other' option — the user can always reply with free text outside this tool if they want.",
        ),
      header: z
        .string()
        .max(12)
        .optional()
        .describe("Very short tag (max 12 chars) summarizing the question. Example: 'Approach'."),
    },
    async (args, extra) => {
      // Convert our friendly options into an MCP elicitation form schema.
      // The schema is a single string property whose `oneOf` carries the
      // label/description pairs. The host (elicitation-manager.ts)
      // recognises this shape and renders options accordingly.
      const oneOf = args.options.map((opt) => ({
        const: opt.label,
        title: opt.label,
      }));

      const message = args.header ? `[${args.header}] ${args.question}` : args.question;

      // Construct the elicitation/create params inline. Shape matches the
      // MCP spec's `ElicitRequestFormParamsSchema` (one string property
      // with a `oneOf` enum for the answer); we don't import the zod
      // schema directly because @modelcontextprotocol/sdk is only a
      // transitive dep of our project.
      const requestPayload = {
        mode: "form" as const,
        message,
        requestedSchema: {
          type: "object" as const,
          properties: {
            answer: {
              type: "string" as const,
              title: "Answer",
              description: "User's selected option.",
              oneOf,
            },
          },
          required: ["answer"],
        },
      };

      // `extra.sendRequest` is the MCP request-handler context's hook.
      // The Claude Agent SDK intercepts `elicitation/create` and routes
      // it to the host's `onElicitation` callback.
      try {
        let result: { action: string; content?: Record<string, unknown> };
        if (options.elicit) {
          // Direct host elicitation (the ElicitationManager). The SDK does NOT
          // forward elicitation/create from in-process MCP servers (-32601), so
          // this is the working path for the daemon's own tools.
          result = await options.elicit(requestPayload, {
            signal: (extra as { signal?: AbortSignal } | undefined)?.signal,
          });
        } else {
          // Fallback: ask over MCP elicitation, for hosts that support it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ext = extra as {
            sendRequest?: (
              req: { method: string; params: unknown },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              resultSchema: any,
            ) => Promise<{ action: string; content?: Record<string, unknown> }>;
          };
          if (!ext?.sendRequest) {
            return {
              content: [
                {
                  type: "text",
                  text: "ask_user: this MCP server is not connected to a host that supports elicitation; ask the user in plain prose instead.",
                },
              ],
              isError: true,
            };
          }
          // Minimal zod result schema (the MCP SDK is only a transitive dep). The
          // shape we accept is the same the ElicitationManager produces.
          const resultSchema = z.object({
            action: z.enum(["accept", "decline", "cancel"]),
            content: z.record(z.string(), z.unknown()).optional(),
          });
          result = await ext.sendRequest(
            { method: "elicitation/create", params: requestPayload },
            resultSchema,
          );
        }

        if (result.action === "accept") {
          const answer = (result.content?.answer as string) ?? "";
          if (!answer) {
            return {
              content: [
                {
                  type: "text",
                  text: "ask_user: user accepted but no answer was returned.",
                },
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `User chose: ${answer}` }],
          };
        }

        if (result.action === "decline") {
          return {
            content: [
              {
                type: "text",
                text: "User declined to answer (or the question timed out). Proceed without this input or ask in plain prose instead.",
              },
            ],
          };
        }

        // "cancel"
        return {
          content: [
            {
              type: "text",
              text: "User cancelled the question. Don't retry the same question; ask differently or move on.",
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, "ask_user elicitation failed");
        return {
          content: [
            {
              type: "text",
              text: `ask_user failed: ${message}. Continue without user input or ask in plain prose instead.`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
