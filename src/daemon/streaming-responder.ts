/**
 * Progressive message updating for channel adapters that support it.
 *
 * Posts an initial placeholder, then throttles updates as text streams in.
 * Used by the gateway to give Slack (and similar platforms) a real-time
 * streaming experience instead of waiting for the full response.
 */

import type { AgentEvent } from "./types.ts";

const MAX_LENGTH = 4000;

type PostFn = (text: string) => Promise<string | undefined>;
type UpdateFn = (messageId: string, text: string) => Promise<void>;
type DeleteFn = (messageId: string) => Promise<void>;

export class StreamingResponder {
  private post: PostFn;
  private update: UpdateFn;
  private deleteFn: DeleteFn | undefined;

  private messageId: string | undefined;
  private buffer = "";
  private lastSent = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private toolInProgress: string | null = null;
  private failed = false;

  constructor(post: PostFn, update: UpdateFn, deleteFn?: DeleteFn, intervalMs = 1500) {
    this.post = post;
    this.update = update;
    this.deleteFn = deleteFn;
    this.intervalMs = intervalMs;
  }

  /** Pass as the `emit` callback to the message queue. */
  handleEvent = (event: AgentEvent): void => {
    if (this.failed) return;

    switch (event.type) {
      case "stream_event": {
        const sdkMsg = event.event as {
          type: string;
          event?: {
            type: string;
            delta?: { type: string; text?: string };
            content_block?: { type: string; name?: string };
          };
        };

        if (sdkMsg.type === "stream_event" && sdkMsg.event) {
          const inner = sdkMsg.event;
          if (inner.type === "content_block_delta") {
            const delta = inner.delta;
            if (delta?.type === "text_delta" && delta.text) {
              this.toolInProgress = null;
              this.buffer += delta.text;
              this.ensureTimer();
            }
          }
        }
        break;
      }

      case "tool_use_summary": {
        this.toolInProgress = event.tool_name;
        this.ensureTimer();
        break;
      }

      case "system": {
        // Post the placeholder on first system event (processing start)
        if (event.subtype === "status" && !this.messageId) {
          this.postPlaceholder();
        }
        break;
      }

      default:
        break;
    }
  };

  /**
   * Finalize the streaming message with the complete response.
   * Returns `true` if the streamer handled delivery (caller should skip normal send).
   * Returns `false` if the message is too long — caller should fall back to chunked send.
   */
  async finalize(fullText: string): Promise<boolean> {
    this.stopTimer();

    if (this.failed || !this.messageId) {
      return false;
    }

    // Long messages: delete placeholder, let the adapter's chunked send() handle it
    if (fullText.length > MAX_LENGTH) {
      if (this.deleteFn) {
        try {
          await this.deleteFn(this.messageId);
        } catch {
          // best-effort cleanup
        }
      }
      return false;
    }

    // Send final complete text
    try {
      await this.update(this.messageId, fullText);
    } catch {
      return false;
    }

    return true;
  }

  private postPlaceholder(): void {
    this.post("_Thinking..._")
      .then((id) => {
        if (id) {
          this.messageId = id;
        } else {
          this.failed = true;
        }
      })
      .catch(() => {
        this.failed = true;
      });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    if (!this.messageId || this.failed) return;

    let text = this.buffer;
    if (this.toolInProgress) {
      text += `\n\n_Using ${this.toolInProgress}..._`;
    }

    // Nothing new to send
    if (text === this.lastSent) return;

    // Truncate if too long for an update (show the tail end)
    if (text.length > MAX_LENGTH) {
      text = "..." + text.slice(text.length - MAX_LENGTH + 3);
    }

    this.lastSent = text;
    this.update(this.messageId, text).catch(() => {
      // Rate-limited or failed — skip this tick, try again next interval
    });
  }
}
