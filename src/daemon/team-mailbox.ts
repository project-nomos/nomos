/**
 * Team mailbox for inter-agent messaging.
 *
 * Provides a simple in-memory message bus for team workers and
 * the coordinator to communicate during multi-agent execution.
 * Messages are stored per-recipient and consumed on read.
 */

export interface TeamMessage {
  from: string;
  to: string;
  message: string;
  priority: "normal" | "urgent" | "blocking";
  timestamp: number;
}

class TeamMailbox {
  /** Messages keyed by recipient ID. */
  private boxes = new Map<string, TeamMessage[]>();

  /** Send a message to a specific agent. */
  send(to: string, message: string, priority: "normal" | "urgent" | "blocking" = "normal"): void {
    const key = to.toLowerCase();
    let box = this.boxes.get(key);
    if (!box) {
      box = [];
      this.boxes.set(key, box);
    }
    box.push({
      from: "agent", // caller identity set by the tool context
      to: key,
      message,
      priority,
      timestamp: Date.now(),
    });
  }

  /** Send a message with explicit sender identity. */
  sendFrom(
    from: string,
    to: string,
    message: string,
    priority: "normal" | "urgent" | "blocking" = "normal",
  ): void {
    const key = to.toLowerCase();
    let box = this.boxes.get(key);
    if (!box) {
      box = [];
      this.boxes.set(key, box);
    }
    box.push({ from, to: key, message, priority, timestamp: Date.now() });
  }

  /**
   * Receive and consume all pending messages for the calling agent.
   * Optionally filter by sender.
   */
  receive(from?: string): TeamMessage[] {
    // In daemon context, we drain all messages (agent identity is implicit)
    const allMessages: TeamMessage[] = [];

    for (const [key, box] of this.boxes) {
      if (from) {
        const matching = box.filter((m) => m.from.toLowerCase() === from.toLowerCase());
        const remaining = box.filter((m) => m.from.toLowerCase() !== from.toLowerCase());
        allMessages.push(...matching);
        if (remaining.length > 0) {
          this.boxes.set(key, remaining);
        } else {
          this.boxes.delete(key);
        }
      } else {
        allMessages.push(...box);
        this.boxes.delete(key);
      }
    }

    // Sort: blocking first, then urgent, then by timestamp
    const priorityOrder = { blocking: 0, urgent: 1, normal: 2 };
    allMessages.sort((a, b) => {
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.timestamp - b.timestamp;
    });

    return allMessages;
  }

  /** Receive messages for a specific recipient without consuming others. */
  receiveFor(recipient: string, from?: string): TeamMessage[] {
    const key = recipient.toLowerCase();
    const box = this.boxes.get(key);
    if (!box || box.length === 0) return [];

    if (from) {
      const matching = box.filter((m) => m.from.toLowerCase() === from.toLowerCase());
      const remaining = box.filter((m) => m.from.toLowerCase() !== from.toLowerCase());
      if (remaining.length > 0) {
        this.boxes.set(key, remaining);
      } else {
        this.boxes.delete(key);
      }
      return matching;
    }

    this.boxes.delete(key);
    return box;
  }

  /** Check if there are pending messages (without consuming). */
  hasPending(recipient?: string): boolean {
    if (recipient) {
      const box = this.boxes.get(recipient.toLowerCase());
      return !!box && box.length > 0;
    }
    for (const box of this.boxes.values()) {
      if (box.length > 0) return true;
    }
    return false;
  }

  /** Clear all messages. */
  clear(): void {
    this.boxes.clear();
  }
}

/** Singleton team mailbox. */
let globalMailbox: TeamMailbox | null = null;

export function getTeamMailbox(): TeamMailbox {
  if (!globalMailbox) {
    globalMailbox = new TeamMailbox();
  }
  return globalMailbox;
}
