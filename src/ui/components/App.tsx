import React, { useState, useRef, useCallback, useEffect } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import type { NomosConfig } from "../../config/env.ts";
import type { AgentIdentity } from "../../config/profile.ts";
import { appendTranscriptMessage } from "../../db/transcripts.ts";
import { updateSessionUsage, updateSessionSdkId } from "../../db/sessions.ts";
import { runSession, type McpServerConfig, type SDKMessage } from "../../sdk/session.ts";
import { TeamRuntime, stripTeamPrefix } from "../../daemon/team-runtime.ts";
import { dispatchSlashCommand, type CommandContext, type CommandState } from "../slash-commands.ts";
import { shouldBootstrap, getBootstrapPrompt } from "../bootstrap.ts";
import { loadHeartbeatFile, isHeartbeatEmpty } from "../../auto-reply/heartbeat.ts";
import type { GrpcClient, ConnectionState } from "../grpc-client.ts";
import type { AgentEvent } from "../../daemon/types.ts";
import { theme } from "../theme.ts";
import { UserMessage } from "./UserMessage.tsx";
import { NomosMessage } from "./NomosMessage.tsx";
import { ToolBlock } from "./ToolBlock.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { CostLine } from "./CostLine.tsx";
import { SystemMessage } from "./SystemMessage.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { CommandInput } from "./CommandInput.tsx";
import { StalledSpinner } from "./StalledSpinner.tsx";
import { CopyModeIndicator } from "./CopyModeIndicator.tsx";
import { ScrollableView } from "./ScrollableView.tsx";
import { stripUnsafeCharacters } from "../text-utils.ts";
import { useAlternateBuffer } from "../hooks/useAlternateBuffer.ts";

/** A finalized item displayed in the Static section. */
interface UIItem {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "system"
    | "tool"
    | "tool-progress"
    | "thinking"
    | "cost"
    | "routing";
  content: string;
  toolMeta?: {
    name: string;
    elapsed: string;
    status: "success" | "error";
    summary?: string;
  };
}

interface ActiveTool {
  name: string;
  startTime: number;
}

let itemCounter = 0;
function nextId(): string {
  return `item-${++itemCounter}`;
}

export interface AppProps {
  config: NomosConfig;
  mcpServers: Record<string, McpServerConfig>;
  session: { id: string; session_key: string };
  transcript: Array<{ role: string; content: string }>;
  systemPromptAppend: string;
  identity: AgentIdentity;
  /** When provided, the App connects to the daemon via gRPC instead of calling runSession() directly. */
  grpcClient?: GrpcClient;
  /** Saved SDK session ID from DB for resuming conversations across restarts. */
  savedSdkSessionId?: string | null;
}

export function App({
  config,
  mcpServers,
  session,
  transcript,
  systemPromptAppend,
  identity,
  grpcClient,
  savedSdkSessionId,
}: AppProps): React.ReactElement {
  const { exit } = useApp();

  const daemonClient = grpcClient;

  // Daemon connection state
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    daemonClient ? "connecting" : null,
  );

  // All finalized items (rendered once via Static)
  const [items, setItems] = useState<UIItem[]>([]);
  // Streaming text for current assistant response
  const [streamingText, setStreamingText] = useState("");
  // Whether we're waiting for the first token
  const [isThinking, setIsThinking] = useState(false);
  // Whether input is active
  const [isInputActive, setIsInputActive] = useState(true);
  const [inputValue, setInputValue] = useState("");
  // Live thinking/reasoning text (streamed then finalized)
  const [thinkingText, setThinkingText] = useState("");
  // Last completed thinking content (kept outside Static so it can be toggled)
  const [lastThinking, setLastThinking] = useState("");
  // Whether the last thinking block is expanded
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // Live tool execution indicator
  const [liveToolName, setLiveToolName] = useState<string | null>(null);
  // Copy mode — pauses all animations and live rendering for text selection
  const [copyMode, setCopyMode] = useState(false);
  // Token tracking for stalled spinner and status line
  const lastTokenAtRef = useRef(Date.now());
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0, cost: 0, turns: 0 });

  // Alternate screen buffer (opt-in via NOMOS_ALTERNATE_BUFFER=true)
  useAlternateBuffer(config.alternateBuffer);
  // Use refs for mutable values accessed inside the async for-await loop
  // (React state is stale inside async generators)
  const activeToolRef = useRef<ActiveTool | null>(null);
  const bufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  // Track whether a tool was used between text blocks, so we can add a paragraph
  // separator when the next text block starts (prevents "sentence1.sentence2" gluing).
  const needsTextSeparatorRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef(transcript);
  const stateRef = useRef<CommandState>({
    model: config.model,
    permissionMode: config.permissionMode,
  });
  const systemPromptAppendRef = useRef(systemPromptAppend);
  const bootstrapChecked = useRef(false);
  // SDK session ID for multi-turn resume (enables auto-compaction).
  // Initialized from DB if resuming an existing session.
  const sdkSessionIdRef = useRef<string | null>(savedSdkSessionId ?? null);
  // Track response message UUID for potential undo
  const lastResponseUuidRef = useRef<string | null>(null);

  const pushItem = useCallback(
    (kind: UIItem["kind"], content: string, toolMeta?: UIItem["toolMeta"]) => {
      setItems((prev) => [...prev, { id: nextId(), kind, content, toolMeta }]);
    },
    [],
  );

  const flushBuffer = useCallback(() => {
    if (bufferRef.current) {
      const text = bufferRef.current;
      bufferRef.current = "";
      setStreamingText((prev) => prev + text);
    }
    if (thinkingBufferRef.current) {
      const text = thinkingBufferRef.current;
      thinkingBufferRef.current = "";
      setThinkingText((prev) => prev + text);
    }
    flushTimerRef.current = null;
  }, []);

  const appendDelta = useCallback(
    (text: string) => {
      bufferRef.current += stripUnsafeCharacters(text);
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushBuffer, 50);
      }
    },
    [flushBuffer],
  );

  // Process an AgentEvent from the daemon WebSocket
  const handleDaemonEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "stream_event": {
          const sdkMsg = event.event as SDKMessage;
          if (sdkMsg.type === "stream_event") {
            const innerEvent = (
              sdkMsg as {
                event: {
                  type: string;
                  delta?: { type: string; text?: string; thinking?: string };
                  content_block?: { type: string; name?: string };
                };
              }
            ).event;
            if (innerEvent.type === "content_block_delta") {
              const delta = innerEvent.delta as { type: string; text?: string; thinking?: string };
              if (delta?.type === "text_delta" && delta.text) {
                if (thinkingBufferRef.current) flushBuffer();
                // Add paragraph break between text blocks separated by tool use
                if (needsTextSeparatorRef.current) {
                  bufferRef.current += "\n\n";
                  needsTextSeparatorRef.current = false;
                }
                setIsThinking(false);
                lastTokenAtRef.current = Date.now();
                appendDelta(delta.text);
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                setIsThinking(false);
                lastTokenAtRef.current = Date.now();
                thinkingBufferRef.current += delta.thinking;
                if (!flushTimerRef.current) {
                  flushTimerRef.current = setTimeout(flushBuffer, 50);
                }
              }
            } else if (innerEvent.type === "content_block_start") {
              const block = innerEvent.content_block as { type: string; name?: string };
              if (block?.type === "tool_use" && block.name) {
                // Finalize accumulated text as a separate message before showing tool
                if (bufferRef.current || thinkingBufferRef.current) flushBuffer();
                setStreamingText((prev) => {
                  if (prev && prev.trim().length >= 3) {
                    pushItem("assistant", prev);
                  }
                  return "";
                });
                activeToolRef.current = { name: block.name, startTime: Date.now() };
                setLiveToolName(block.name);
              } else if (block?.type === "thinking") {
                setIsThinking(false);
              }
            } else if (innerEvent.type === "content_block_stop") {
              if (thinkingBufferRef.current) flushBuffer();
            }
          }
          break;
        }

        case "tool_use_summary": {
          const tool = activeToolRef.current;
          if (tool) {
            const elapsed = ((Date.now() - tool.startTime) / 1000).toFixed(1) + "s";
            pushItem("tool", `${tool.name} (${elapsed})`, {
              name: tool.name,
              elapsed,
              status: "success",
              summary: event.summary || undefined,
            });
            activeToolRef.current = null;
          }
          setLiveToolName(null);
          break;
        }

        case "result": {
          // Flush and finalize
          if (bufferRef.current || thinkingBufferRef.current) flushBuffer();
          setIsThinking(false);
          setLiveToolName(null);
          activeToolRef.current = null;

          // Update token usage
          const inp = event.usage?.input_tokens ?? 0;
          const out = event.usage?.output_tokens ?? 0;
          if (inp > 0 || out > 0) {
            setSessionTokens((prev) => ({
              input: prev.input + inp,
              output: prev.output + out,
              cost: prev.cost,
              turns: prev.turns + 1,
            }));
          }

          setIsInputActive(true);
          break;
        }

        case "system": {
          if (event.subtype === "routing") {
            pushItem("routing", event.message);
          } else if (event.subtype === "status") {
            // Team progress updates — show as dim system messages
            pushItem("system", event.message);
          } else if (event.subtype !== "init" && event.subtype !== "command_ack") {
            pushItem("system", event.message);
          }
          break;
        }

        case "error": {
          if (bufferRef.current || thinkingBufferRef.current) flushBuffer();
          setIsThinking(false);
          setLiveToolName(null);
          activeToolRef.current = null;
          pushItem("system", `Error: ${event.message}`);
          setIsInputActive(true);
          break;
        }
      }
    },
    [pushItem, appendDelta, flushBuffer],
  );

  // Connect to daemon (gRPC or WebSocket) if a daemon client is provided
  useEffect(() => {
    if (!daemonClient) return;

    daemonClient.onConnectionStateChange(setConnectionState);
    const removeListener = daemonClient.onEvent(handleDaemonEvent);

    daemonClient.connect().catch((err) => {
      pushItem(
        "system",
        `Failed to connect to daemon: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return () => {
      removeListener();
      daemonClient.disconnect();
    };
  }, [daemonClient, handleDaemonEvent, pushItem]);

  // Run a user message through the SDK (or daemon)
  const handleUserMessage = useCallback(
    async (input: string) => {
      pushItem("user", input);

      await appendTranscriptMessage({
        sessionId: session.id,
        role: "user",
        content: input,
      });
      transcriptRef.current.push({ role: "user", content: input });

      // Reset turn state
      setStreamingText("");
      setThinkingText("");
      setLastThinking("");
      setThinkingExpanded(false);
      setIsThinking(true);
      setIsInputActive(false);
      setLiveToolName(null);
      activeToolRef.current = null;
      thinkingBufferRef.current = "";
      needsTextSeparatorRef.current = false;

      // Daemon mode: send via gRPC or WebSocket and return
      if (daemonClient) {
        try {
          daemonClient.sendMessage(input, session.session_key);
        } catch (err) {
          setIsThinking(false);
          const message = err instanceof Error ? err.message : String(err);
          pushItem("system", `Error: ${message}`);
          setIsInputActive(true);
        }
        return;
      }

      // Team mode: handle /team prefix in CLI direct mode
      const teamTask = config.teamMode ? stripTeamPrefix(input) : null;
      if (teamTask) {
        pushItem("system", "Running multi-agent team...");
        try {
          const teamRuntime = new TeamRuntime({
            maxWorkers: config.maxTeamWorkers,
            coordinatorModel: stateRef.current.model,
          });
          const allowedTools = ["Bash", ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
          const result = await teamRuntime.runTeam(
            {
              prompt: teamTask,
              systemPromptAppend: systemPromptAppendRef.current,
              mcpServers,
              permissionMode: stateRef.current.permissionMode ?? config.permissionMode,
              allowedTools,
            },
            (event) => {
              pushItem("system", event.message);
            },
          );

          if (bufferRef.current || thinkingBufferRef.current) flushBuffer();
          setIsThinking(false);

          const content = result || "_(no response)_";
          appendDelta(content);
          flushBuffer();

          await appendTranscriptMessage({
            sessionId: session.id,
            role: "assistant",
            content,
          });
          transcriptRef.current.push({ role: "assistant", content });

          setIsInputActive(true);
          return;
        } catch (err) {
          setIsThinking(false);
          const message = err instanceof Error ? err.message : String(err);
          pushItem("system", `Team error: ${message}`);
          setIsInputActive(true);
          return;
        }
      }

      // Capture stderr for debug diagnostics on failure
      const stderrChunks: string[] = [];

      try {
        // Map thinking level to SDK options
        const thinkingLevel = stateRef.current.thinkingLevel ?? "high";
        let thinking:
          | { type: "adaptive" }
          | { type: "enabled"; budgetTokens: number }
          | { type: "disabled" }
          | undefined;

        switch (thinkingLevel) {
          case "off":
            thinking = { type: "disabled" };
            break;
          case "minimal":
            thinking = { type: "enabled", budgetTokens: 1024 };
            break;
          case "low":
            thinking = { type: "enabled", budgetTokens: 2048 };
            break;
          case "medium":
            thinking = { type: "enabled", budgetTokens: 5000 };
            break;
          case "high":
            thinking = { type: "adaptive" };
            break;
          case "max":
            thinking = { type: "enabled", budgetTokens: 32000 };
            break;
        }

        // Auto-approve all tools from our MCP servers so the agent
        // can use them without permission prompts in acceptEdits mode.
        // Also allow Bash — our permissions system (check_permission / grant_permission MCP tools)
        // handles fine-grained command approval conversationally, so the SDK's built-in
        // permission layer should not block commands that the agent has already cleared.
        const allowedTools = ["Bash", ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];

        const stderrCallback = (data: string) => {
          stderrChunks.push(data);
          // Keep only last 50 lines to avoid unbounded memory
          if (stderrChunks.length > 50) stderrChunks.shift();
        };

        let sdkQuery = runSession({
          prompt: input,
          model: stateRef.current.model,
          mcpServers,
          systemPromptAppend: systemPromptAppendRef.current,
          permissionMode: stateRef.current.permissionMode ?? config.permissionMode,
          resume: sdkSessionIdRef.current ?? undefined,
          thinking,
          allowedTools,
          stderr: stderrCallback,
        });

        const textParts: string[] = [];

        // Wrap iteration with resume-fallback: if resuming fails, retry without resume
        const iterate = async function* () {
          try {
            for await (const msg of sdkQuery) {
              yield msg;
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (sdkSessionIdRef.current && /session|conversation/i.test(errMsg)) {
              // Resume failed — clear stale session and retry fresh
              sdkSessionIdRef.current = null;
              sdkQuery = runSession({
                prompt: input,
                model: stateRef.current.model,
                mcpServers,
                systemPromptAppend: systemPromptAppendRef.current,
                permissionMode: stateRef.current.permissionMode ?? config.permissionMode,
                thinking,
                allowedTools,
                stderr: stderrCallback,
              });
              for await (const msg of sdkQuery) {
                yield msg;
              }
            } else {
              throw err;
            }
          }
        };

        for await (const msg of iterate()) {
          switch (msg.type) {
            case "assistant": {
              // Track response message UUID for potential undo
              const responseMsg = msg as {
                uuid?: string;
                message: { content: Array<{ type: string; text?: string }> };
              };
              if (responseMsg.uuid) {
                lastResponseUuidRef.current = responseMsg.uuid;
              }
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  textParts.push(block.text);
                }
              }
              break;
            }

            case "stream_event": {
              const event = msg.event;
              if (event.type === "content_block_delta") {
                const delta = event.delta as { type: string; text?: string; thinking?: string };
                if (delta.type === "text_delta" && delta.text) {
                  // Finalize thinking block if transitioning from thinking to text
                  if (thinkingBufferRef.current) flushBuffer();
                  // Add paragraph break between text blocks separated by tool use
                  if (needsTextSeparatorRef.current) {
                    bufferRef.current += "\n\n";
                    needsTextSeparatorRef.current = false;
                  }
                  setIsThinking(false);
                  lastTokenAtRef.current = Date.now();
                  appendDelta(delta.text);
                } else if (delta.type === "thinking_delta" && delta.thinking) {
                  // Buffer thinking content
                  setIsThinking(false);
                  lastTokenAtRef.current = Date.now();
                  thinkingBufferRef.current += delta.thinking;
                  if (!flushTimerRef.current) {
                    flushTimerRef.current = setTimeout(flushBuffer, 50);
                  }
                }
              } else if (event.type === "content_block_start") {
                const block = event.content_block as { type: string; name?: string };
                if (block.type === "tool_use" && block.name) {
                  // Finalize accumulated text as a separate message before showing tool
                  if (bufferRef.current || thinkingBufferRef.current) flushBuffer();
                  setStreamingText((prev) => {
                    if (prev && prev.trim().length >= 3) {
                      pushItem("assistant", prev);
                    }
                    return "";
                  });
                  activeToolRef.current = { name: block.name, startTime: Date.now() };
                  setLiveToolName(block.name);
                } else if (block.type === "thinking") {
                  setIsThinking(false);
                }
              } else if (event.type === "content_block_stop") {
                // When a thinking block ends, finalize it
                if (thinkingBufferRef.current) flushBuffer();
              }
              break;
            }

            case "tool_use_summary": {
              const tool = activeToolRef.current;
              if (tool) {
                const elapsed = ((Date.now() - tool.startTime) / 1000).toFixed(1) + "s";
                const summary = msg.summary ? ` ${msg.summary}` : undefined;
                pushItem("tool", `${tool.name} (${elapsed})${summary ?? ""}`, {
                  name: tool.name,
                  elapsed,
                  status: "success",
                  summary: msg.summary || undefined,
                });
                activeToolRef.current = null;
              } else if (msg.summary) {
                pushItem("tool", msg.summary);
              }
              setLiveToolName(null);
              break;
            }

            case "tool_progress": {
              const progressMsg = msg as { tool_name: string; elapsed_time_seconds: number };
              setLiveToolName(progressMsg.tool_name);
              break;
            }

            case "system": {
              // Capture SDK session ID for multi-turn resume
              const sysMsg = msg as {
                session_id?: string;
                subtype: string;
                tools?: unknown[];
                mcp_servers?: unknown[];
                status?: string;
                compact_metadata?: { trigger: string; pre_tokens: number };
              };
              if (sysMsg.session_id && !sdkSessionIdRef.current) {
                sdkSessionIdRef.current = sysMsg.session_id;
              }
              if (sysMsg.subtype === "init") {
                const toolCount = (sysMsg.tools as unknown[])?.length ?? 0;
                const mcpCount = (sysMsg.mcp_servers as unknown[])?.length ?? 0;
                pushItem("system", `${toolCount} tools, ${mcpCount} MCP servers`);
              } else if (sysMsg.subtype === "status" && sysMsg.status === "compacting") {
                pushItem("system", "Compacting conversation...");
              } else if (sysMsg.subtype === "compact_boundary" && sysMsg.compact_metadata) {
                const preTokens = sysMsg.compact_metadata.pre_tokens;
                const tokensFormatted =
                  preTokens >= 1000 ? `${(preTokens / 1000).toFixed(1)}K` : String(preTokens);
                pushItem("system", `Context compacted (was ~${tokensFormatted} tokens)`);
              } else if (sysMsg.subtype === "task_started") {
                const taskMsg = sysMsg as unknown as { description: string };
                if (taskMsg.description) {
                  pushItem("system", `Task started: ${taskMsg.description}`);
                }
              } else if (sysMsg.subtype === "task_notification") {
                const taskMsg = sysMsg as unknown as { status: string; summary: string };
                pushItem("system", `Task ${taskMsg.status}: ${taskMsg.summary}`);
              }
              break;
            }

            case "result": {
              if (msg.subtype !== "success") {
                const errorMsg = msg as { errors?: string[] };
                if (errorMsg.errors?.length) {
                  pushItem("system", `Error: ${errorMsg.errors.join(", ")}`);
                }
              }
              // Update token usage and session usage
              const inp = msg.usage.input_tokens;
              const out = msg.usage.output_tokens;
              if (inp > 0 || out > 0) {
                updateSessionUsage(session.id, inp, out).catch(() => {});
                setSessionTokens((prev) => ({
                  input: prev.input + inp,
                  output: prev.output + out,
                  cost: prev.cost,
                  turns: prev.turns + 1,
                }));
              }

              // Persist SDK session ID to DB for resume across restarts
              if (sdkSessionIdRef.current) {
                updateSessionSdkId(session.session_key, sdkSessionIdRef.current).catch(() => {});
              }
              break;
            }

            default:
              break;
          }
        }

        // Flush remaining text and thinking
        if (bufferRef.current || thinkingBufferRef.current) flushBuffer();

        setIsThinking(false);
        setLiveToolName(null);
        activeToolRef.current = null;

        // Persist assistant response
        if (textParts.length > 0) {
          const responseText = textParts.join("\n\n");
          await appendTranscriptMessage({
            sessionId: session.id,
            role: "assistant",
            content: responseText,
          });
          transcriptRef.current.push({ role: "assistant", content: responseText });
        }
      } catch (error) {
        setIsThinking(false);
        setLiveToolName(null);
        activeToolRef.current = null;
        const message = error instanceof Error ? error.message : String(error);
        pushItem("system", `Error: ${message}`);
        // Surface stderr output for debugging SDK failures
        if (stderrChunks.length > 0) {
          const stderrOutput = stderrChunks.join("").trim();
          if (stderrOutput) {
            pushItem("system", `stderr:\n${stderrOutput}`);
          }
        }
      }

      setIsInputActive(true);
    },
    [mcpServers, session.id, pushItem, appendDelta, flushBuffer],
  );

  // When streaming finishes and input becomes active, finalize messages.
  // Long responses are split into chunks for better scroll performance.
  useEffect(() => {
    if (isInputActive) {
      // Finalize thinking — keep as live state (not Static) so it can be toggled
      if (thinkingText) {
        setLastThinking(thinkingText);
        setThinkingExpanded(false);
        setThinkingText("");
      }
      if (streamingText && streamingText.trim().length >= 3) {
        const MAX_LINES_PER_CHUNK = 150;
        const lines = streamingText.split("\n");
        if (lines.length > MAX_LINES_PER_CHUNK) {
          for (let i = 0; i < lines.length; i += MAX_LINES_PER_CHUNK) {
            const chunk = lines.slice(i, i + MAX_LINES_PER_CHUNK).join("\n");
            pushItem("assistant", chunk);
          }
        } else {
          pushItem("assistant", streamingText);
        }
        setStreamingText("");
      } else if (streamingText) {
        setStreamingText("");
      }
    }
  }, [isInputActive, streamingText, thinkingText, pushItem]);

  // Inject prior conversation context into the system prompt so the agent
  // remembers the user's name, preferences, and recent exchanges.
  // This acts as a safety net even when SDK session resume is available —
  // if the resume works, the SDK already has full context and this is redundant;
  // if the resume fails (expired session), this prevents a cold start.
  useEffect(() => {
    if (bootstrapChecked.current) return;

    if (transcript.length > 0) {
      // Take the most recent messages (limit to avoid huge prompts)
      const recent = transcript.slice(-30);
      const history = recent.map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`).join("\n\n");
      systemPromptAppendRef.current =
        systemPromptAppendRef.current +
        "\n\n## Previous Conversation\n" +
        "The following is the most recent conversation history with this user. " +
        "Use it to maintain continuity — remember their name, preferences, and context. " +
        "Do NOT re-introduce yourself or ask who they are if you can see prior exchanges.\n\n" +
        history;
    }
  }, [transcript]);

  // Check for first-run bootstrapping
  useEffect(() => {
    if (bootstrapChecked.current) return;
    bootstrapChecked.current = true;

    (async () => {
      const needsBootstrap = await shouldBootstrap(transcript.length);
      if (!needsBootstrap) return;

      // Inject bootstrap prompt into system prompt
      const bootstrapPrompt = getBootstrapPrompt(identity);
      systemPromptAppendRef.current = systemPromptAppend + "\n\n" + bootstrapPrompt;

      // Auto-send a greeting to trigger the bootstrap conversation
      await handleUserMessage("Hello!");
    })();
  }, [identity, systemPromptAppend, handleUserMessage, transcript.length]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  // Listen for permission mode changes from MCP tool (switch_permission_mode)
  useEffect(() => {
    const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;
    type Mode = (typeof validModes)[number];
    const handler = (mode: unknown) => {
      if (typeof mode === "string" && validModes.includes(mode as Mode)) {
        stateRef.current.permissionMode = mode as Mode;
        pushItem("system", `Permission mode changed to **${mode}**`);
      }
    };
    process.on("nomos:mode_change" as never, handler as never);
    return () => {
      process.off("nomos:mode_change" as never, handler as never);
    };
  }, [pushItem]);

  // Heartbeat system: periodically check HEARTBEAT.md and send as user message if non-empty
  useEffect(() => {
    if (config.heartbeatIntervalMs <= 0) return;

    const intervalId = setInterval(() => {
      // Only send heartbeat when input is active (agent is idle)
      if (!isInputActive) return;

      const heartbeatContent = loadHeartbeatFile();
      if (!heartbeatContent || isHeartbeatEmpty(heartbeatContent)) return;

      // Send heartbeat content as a user message with a system note
      const heartbeatMessage = `${heartbeatContent}\n\n<!-- Heartbeat check — review HEARTBEAT.md for pending tasks -->`;
      handleUserMessage(heartbeatMessage);
    }, config.heartbeatIntervalMs);

    return () => clearInterval(intervalId);
  }, [config.heartbeatIntervalMs, isInputActive, handleUserMessage]);

  // Handle input submission
  const handleSubmit = useCallback(
    async (value: string) => {
      const input = value.trim();
      setInputValue("");
      if (!input) return;

      if (input.startsWith("/")) {
        const ctx: CommandContext = {
          transcript: transcriptRef.current,
          session,
          state: stateRef.current,
          config,
          mcpServers,
        };

        const result = await dispatchSlashCommand(input, ctx);

        if (result.quit) {
          exit();
          return;
        }

        if (result.output) {
          pushItem("system", result.output);
        }

        if (result.compact) {
          // Clear items visually and reset SDK session (fresh context)
          setItems([]);
          sdkSessionIdRef.current = null;
        }

        if (result.passthrough) {
          await handleUserMessage(result.passthrough);
        }
        return;
      }

      await handleUserMessage(input);
    },
    [session, config, mcpServers, handleUserMessage, pushItem, exit],
  );

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
      return;
    }
    // Toggle copy mode with Ctrl+S
    if (key.ctrl && _input === "s") {
      setCopyMode((prev) => !prev);
      return;
    }
    // Toggle thinking expansion with Tab (only when input is empty)
    if (key.tab && !inputValue && lastThinking && isInputActive) {
      setThinkingExpanded((prev) => !prev);
      return;
    }
    // Exit copy mode on Escape
    if (key.escape && copyMode) {
      setCopyMode(false);
      return;
    }
  });

  const promptChar = identity.emoji ? `${identity.emoji} ` : "";

  const renderItem = (item: UIItem): React.ReactElement | null => {
    switch (item.kind) {
      case "user":
        return <UserMessage key={item.id} content={item.content} />;
      case "assistant":
        return <NomosMessage key={item.id} content={item.content} />;
      case "thinking":
        return <ThinkingBlock key={item.id} content={item.content} />;
      case "tool":
        return item.toolMeta ? (
          <ToolBlock key={item.id} {...item.toolMeta} />
        ) : (
          <SystemMessage key={item.id} content={item.content} />
        );
      case "tool-progress":
        return <SystemMessage key={item.id} content={item.content} />;
      case "cost":
        return <CostLine key={item.id} content={item.content} />;
      case "routing":
        return (
          <Box key={item.id} paddingLeft={3}>
            <Text color={theme.text.accent}>⇢ </Text>
            <Text dimColor>{item.content}</Text>
          </Box>
        );
      case "system":
        return <SystemMessage key={item.id} content={item.content} />;
      default:
        return null;
    }
  };

  return (
    <Box flexDirection="column">
      {/* Completed items — rendered once, scroll up */}
      {config.alternateBuffer ? (
        <ScrollableView height={(process.stdout.rows || 24) - 4}>
          {items.map((item) => renderItem(item))}
        </ScrollableView>
      ) : (
        <Static items={items}>{(item) => renderItem(item)}</Static>
      )}

      {/* Copy mode indicator */}
      {copyMode && <CopyModeIndicator />}

      {/* Live UI — hidden in copy mode to allow text selection */}
      {!copyMode && (
        <>
          {/* Last completed thinking — toggleable with Ctrl+T */}
          {lastThinking && isInputActive && (
            <ThinkingBlock content={lastThinking} expanded={thinkingExpanded} />
          )}

          {/* Streaming text — shown first, content flows naturally */}
          {streamingText && <NomosMessage content={streamingText} />}

          {/* Live thinking/reasoning — shown below text during streaming */}
          {thinkingText && !isInputActive && <ThinkingBlock content={thinkingText} live />}

          {/* Live tool execution indicator — inline spinner below content */}
          {liveToolName && !isInputActive && <ToolBlock name={liveToolName} status="executing" />}

          {/* Thinking spinner — shown when waiting for first token */}
          {isThinking && !streamingText && !thinkingText && !liveToolName && (
            <Box marginTop={1}>
              <StalledSpinner
                mode={liveToolName ? "tool-use" : "thinking"}
                label="Thinking..."
                lastTokenAt={lastTokenAtRef.current}
              />
            </Box>
          )}

          {/* Input area */}
          {isInputActive && (
            <CommandInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              focus={isInputActive && !copyMode}
              prompt={`${promptChar}${theme.symbol.user} `}
            />
          )}

          {/* Connection status (daemon mode) */}
          {connectionState && connectionState !== "connected" && (
            <Box>
              <Text color="yellow" dimColor>
                {connectionState === "connecting"
                  ? "Connecting to daemon..."
                  : connectionState === "reconnecting"
                    ? "Reconnecting to daemon..."
                    : "Disconnected from daemon"}
              </Text>
            </Box>
          )}

          {/* Status line */}
          {isInputActive && (
            <StatusLine
              data={{
                model: stateRef.current.model,
                inputTokens: sessionTokens.input,
                outputTokens: sessionTokens.output,
                costUsd: sessionTokens.cost,
                turnCount: sessionTokens.turns,
                permissionMode: stateRef.current.permissionMode ?? config.permissionMode,
              }}
            />
          )}
        </>
      )}
    </Box>
  );
}
